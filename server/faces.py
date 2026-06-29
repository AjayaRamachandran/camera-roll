"""
Pluggable face engine: detect faces and turn each into a comparable embedding.

The rest of the app talks to this module through two things only:

    detect_and_embed(image) -> list[FaceEmbedding]
    distance(a, b) -> float          # 0 == identical, larger == less alike

so the underlying models can be swapped without touching the indexing logic.

The current implementation runs two ONNX models via onnxruntime:

  * a detector (SCRFD, as shipped in InsightFace "buffalo" packs) that returns
    face boxes plus five facial landmarks, and
  * an ArcFace recognizer that turns an aligned 112x112 face crop into a
    512-d, L2-normalized embedding.

Only numpy and Pillow are used for the pre/post-processing (letterboxing,
landmark alignment, the warp), so there is no OpenCV dependency. Models are
loaded lazily on first use, so an install that is missing onnxruntime or the
model files never blocks server startup or the main library scan; the caller
catches the error and parks the face pass.
"""

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

import imaging

_FACE_CFG = imaging.CONFIG["secondary_index"]["faces"]
SIMILAR_THRESHOLD: float = float(_FACE_CFG["similar_threshold"])
MIN_DET_SCORE: float = float(_FACE_CFG["min_det_score"])
# Threads each model run may use. Kept low (1) so the indexer can run many
# photos concurrently across cores rather than one photo across all cores.
INTRA_OP_THREADS: int = int(_FACE_CFG.get("ort_intra_op_threads", 0))

# Where to look for the .onnx files. Empty config -> <indexes_root>/models,
# which is shared across every library (the models are not library-specific).
_models_dir_cfg = (_FACE_CFG.get("models_dir") or "").strip()
MODELS_DIR = Path(_models_dir_cfg) if _models_dir_cfg else imaging.MODELS_ROOT

# Canonical 5-point template ArcFace expects, for a 112x112 aligned crop.
_ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)

_NMS_THRESHOLD = 0.4
_DETECTOR_STRIDES = (8, 16, 32)


@dataclass
class FaceEmbedding:
    """One detected face: where it is and what it looks like."""

    bbox: tuple[int, int, int, int]  # x, y, w, h in the passed-in image's coords
    embedding: list[float]           # 512-d, L2-normalized
    det_score: float


# --------------------------------------------------------------------------- #
# Lazy model loading
# --------------------------------------------------------------------------- #

_lock = threading.Lock()
_detector = None
_recognizer = None
_engine_name = "uninitialized"


class FaceEngineError(RuntimeError):
    """Raised when the models cannot be found or loaded."""


def engine_name() -> str:
    return _engine_name


def _classify_sessions(paths: list[Path]):
    """Sort the available .onnx files into (detector, recognizer).

    Rather than rely on exact filenames, we inspect each model: the recognizer
    has a single output, the detector has several (one group per stride). This
    keeps the engine working regardless of how the model files were named.
    """
    import onnxruntime as ort

    # The SCRFD detector is exported with output-shape hints for a 640px input;
    # we feed a larger image, so onnxruntime would log a benign shape-mismatch
    # warning for every output on every call. Quiet it to errors only.
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    if INTRA_OP_THREADS > 0:
        opts.intra_op_num_threads = INTRA_OP_THREADS

    detector = recognizer = None
    for p in paths:
        sess = ort.InferenceSession(
            str(p), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        n_out = len(sess.get_outputs())
        # The recognizer emits a single 512-d embedding; the detector emits one
        # group of outputs per stride. Check the output width too, so stray
        # single-output models (landmarks, gender/age) are not mistaken for it.
        if n_out == 1:
            out_dim = sess.get_outputs()[0].shape[-1]
            if recognizer is None and isinstance(out_dim, int) and out_dim >= 128:
                recognizer = sess
        elif n_out > 1 and detector is None:
            detector = sess
    return detector, recognizer


def _ensure_loaded() -> None:
    global _detector, _recognizer, _engine_name
    if _detector is not None and _recognizer is not None:
        return
    with _lock:
        if _detector is not None and _recognizer is not None:
            return
        try:
            import onnxruntime  # noqa: F401  (import surfaces a clear error early)
        except Exception as exc:  # pragma: no cover - depends on install
            raise FaceEngineError(
                "onnxruntime is not installed; run pip install -r requirements.txt"
            ) from exc

        if not MODELS_DIR.exists():
            raise FaceEngineError(
                f"face model folder not found: {MODELS_DIR}. Place a detector and "
                "an ArcFace recognizer .onnx there (see server/README.md)."
            )
        onnx_files = sorted(MODELS_DIR.glob("*.onnx"))
        if len(onnx_files) < 2:
            raise FaceEngineError(
                f"expected at least two .onnx models in {MODELS_DIR}, found "
                f"{len(onnx_files)} (need a face detector and an ArcFace recognizer)."
            )

        detector, recognizer = _classify_sessions(onnx_files)
        if detector is None or recognizer is None:
            raise FaceEngineError(
                "could not identify both a detector and a recognizer among the "
                f"models in {MODELS_DIR}."
            )
        _detector, _recognizer = detector, recognizer
        rec_out = _recognizer.get_outputs()[0].shape
        _engine_name = f"onnx-arcface({rec_out[-1]})"


# --------------------------------------------------------------------------- #
# Detector (SCRFD)
# --------------------------------------------------------------------------- #

def _detector_input_size() -> tuple[int, int]:
    """(width, height) the detector expects. Falls back to the configured size."""
    shape = _detector.get_inputs()[0].shape  # [N, 3, H, W]
    h, w = shape[2], shape[3]
    if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
        return w, h
    size = int(_FACE_CFG["detection_input_size"])
    size = max(32, (size // 32) * 32)  # SCRFD needs a multiple of 32
    return size, size


def _letterbox(img: "Image.Image", out_w: int, out_h: int) -> tuple[np.ndarray, float]:
    """Resize keeping aspect onto a top-left-anchored black canvas; return scale."""
    w, h = img.size
    scale = min(out_w / w, out_h / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (out_w, out_h), (0, 0, 0))
    canvas.paste(resized, (0, 0))
    return np.asarray(canvas, dtype=np.float32), scale


def _anchor_centers(h: int, w: int, stride: int, num_anchors: int) -> np.ndarray:
    """Grid of anchor centers in input-image pixels, matching SCRFD's layout."""
    ys, xs = np.mgrid[:h, :w]
    centers = np.stack([xs, ys], axis=-1).astype(np.float32) * stride
    centers = centers.reshape(-1, 2)
    if num_anchors > 1:
        centers = np.repeat(centers, num_anchors, axis=0)
    return centers


def _distance2bbox(centers: np.ndarray, dist: np.ndarray) -> np.ndarray:
    x1 = centers[:, 0] - dist[:, 0]
    y1 = centers[:, 1] - dist[:, 1]
    x2 = centers[:, 0] + dist[:, 2]
    y2 = centers[:, 1] + dist[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def _distance2kps(centers: np.ndarray, dist: np.ndarray) -> np.ndarray:
    pts = []
    for i in range(0, dist.shape[1], 2):
        pts.append(centers[:, 0] + dist[:, i])
        pts.append(centers[:, 1] + dist[:, i + 1])
    return np.stack(pts, axis=-1)


def _nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= thresh]
    return keep


def _detect(img: "Image.Image") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (boxes Nx4, scores N, landmarks Nx5x2) in the passed image's coords."""
    in_w, in_h = _detector_input_size()
    arr, det_scale = _letterbox(img, in_w, in_h)
    blob = ((arr - 127.5) / 128.0).transpose(2, 0, 1)[None]  # (1,3,H,W) RGB
    outs = _detector.run(None, {_detector.get_inputs()[0].name: blob.astype(np.float32)})

    # Group the outputs by their channel width instead of trusting node order:
    # scores have width 1, bbox deltas width 4, landmark deltas width 10.
    flat = []
    for o in outs:
        a = np.array(o)
        if a.ndim == 3:
            a = a[0]
        elif a.ndim == 1:
            a = a[:, None]
        flat.append(a)
    scores_g = sorted((a for a in flat if a.shape[1] == 1), key=len, reverse=True)
    bbox_g = sorted((a for a in flat if a.shape[1] == 4), key=len, reverse=True)
    kps_g = sorted((a for a in flat if a.shape[1] == 10), key=len, reverse=True)
    if not (len(scores_g) == len(bbox_g) == len(kps_g) == len(_DETECTOR_STRIDES)):
        raise FaceEngineError("unexpected detector output layout; not an SCRFD-KPS model?")

    boxes_all, scores_all, kps_all = [], [], []
    for idx, stride in enumerate(_DETECTOR_STRIDES):
        scores = scores_g[idx][:, 0]
        bbox_pred = bbox_g[idx] * stride
        kps_pred = kps_g[idx] * stride
        fh, fw = in_h // stride, in_w // stride
        num_anchors = scores.shape[0] // (fh * fw)
        centers = _anchor_centers(fh, fw, stride, num_anchors)

        keep = np.where(scores >= MIN_DET_SCORE)[0]
        if keep.size == 0:
            continue
        boxes = _distance2bbox(centers, bbox_pred)[keep] / det_scale
        kps = _distance2kps(centers, kps_pred)[keep] / det_scale
        boxes_all.append(boxes)
        scores_all.append(scores[keep])
        kps_all.append(kps.reshape(-1, 5, 2))

    if not boxes_all:
        return np.empty((0, 4)), np.empty((0,)), np.empty((0, 5, 2))

    boxes = np.vstack(boxes_all)
    scores = np.concatenate(scores_all)
    kps = np.vstack(kps_all)
    keep = _nms(boxes, scores, _NMS_THRESHOLD)
    return boxes[keep], scores[keep], kps[keep]


# --------------------------------------------------------------------------- #
# Recognizer (ArcFace)
# --------------------------------------------------------------------------- #

def _umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform (scale+rot+translation) mapping src->dst.

    Returns a 3x3 homogeneous matrix. This is the classic Umeyama (1991)
    estimate, the same one InsightFace uses to align faces to the template.
    """
    num, dim = src.shape
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_demean = src - src_mean
    dst_demean = dst - dst_mean
    A = dst_demean.T @ src_demean / num
    d = np.ones(dim)
    if np.linalg.det(A) < 0:
        d[dim - 1] = -1
    T = np.eye(dim + 1)
    U, S, Vt = np.linalg.svd(A)
    rank = np.linalg.matrix_rank(A)
    if rank == 0:
        return np.full((dim + 1, dim + 1), np.nan)
    if rank == dim - 1:
        if np.linalg.det(U) * np.linalg.det(Vt) > 0:
            T[:dim, :dim] = U @ Vt
        else:
            s = d[dim - 1]
            d[dim - 1] = -1
            T[:dim, :dim] = U @ np.diag(d) @ Vt
            d[dim - 1] = s
    else:
        T[:dim, :dim] = U @ np.diag(d) @ Vt
    var_src = src_demean.var(axis=0).sum()
    scale = (S @ d) / var_src
    T[:dim, dim] = dst_mean - scale * (T[:dim, :dim] @ src_mean)
    T[:dim, :dim] *= scale
    return T


def _align(img: "Image.Image", landmarks: np.ndarray) -> "Image.Image":
    """Warp the face to a 112x112 crop aligned to the ArcFace template."""
    M = _umeyama(landmarks.astype(np.float32), _ARCFACE_TEMPLATE)
    Minv = np.linalg.inv(M)  # PIL maps output coords -> input coords
    coeffs = (
        Minv[0, 0], Minv[0, 1], Minv[0, 2],
        Minv[1, 0], Minv[1, 1], Minv[1, 2],
    )
    return img.transform((112, 112), Image.AFFINE, coeffs, resample=Image.BILINEAR)


def _embed(face: "Image.Image") -> np.ndarray:
    arr = np.asarray(face.convert("RGB"), dtype=np.float32)
    blob = ((arr - 127.5) / 127.5).transpose(2, 0, 1)[None].astype(np.float32)
    out = _recognizer.run(None, {_recognizer.get_inputs()[0].name: blob})[0]
    vec = np.asarray(out).reshape(-1)
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def detect_and_embed(image: "Image.Image") -> list[FaceEmbedding]:
    """Find every face in `image` and return its box, score, and embedding."""
    _ensure_loaded()
    boxes, scores, kpss = _detect(image)
    results: list[FaceEmbedding] = []
    for box, score, kps in zip(boxes, scores, kpss):
        aligned = _align(image, kps)
        emb = _embed(aligned)
        x1, y1, x2, y2 = box
        results.append(
            FaceEmbedding(
                bbox=(int(round(x1)), int(round(y1)),
                      int(round(x2 - x1)), int(round(y2 - y1))),
                embedding=[float(v) for v in emb],
                det_score=float(score),
            )
        )
    return results


def distance(a, b) -> float:
    """Cosine distance between two L2-normalized embeddings (0 == identical)."""
    va = np.asarray(a, dtype=np.float32)
    vb = np.asarray(b, dtype=np.float32)
    return float(1.0 - np.dot(va, vb))
