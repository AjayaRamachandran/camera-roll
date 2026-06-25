import { useEffect, useRef, useState } from "react";

import { Pause, Play } from "lucide-react";

import { formatDuration } from "@/lib/photoApi";
import Refract from "./Refract";

interface VideoScrubBarProps {
  /** The video element to drive. Re-wires when it changes (e.g. on swipe). */
  video: HTMLVideoElement | null;
}

/**
 * A floating liquid-glass pill that controls the video playing behind it:
 * play/pause, a draggable scrub track with a played fill, and time readouts.
 * It owns no video element of its own; it attaches to whatever element the
 * detail view hands it and mirrors that element's state.
 */
export default function VideoScrubBar({ video }: VideoScrubBarProps) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  // Mirror the element's state. Re-subscribe whenever the element changes.
  useEffect(() => {
    if (!video) return;
    const sync = () => {
      setPlaying(!video.paused);
      setCurrent(video.currentTime);
      if (isFinite(video.duration)) setDuration(video.duration);
    };
    sync();
    video.addEventListener("timeupdate", sync);
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("play", sync);
      video.removeEventListener("pause", sync);
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
    };
  }, [video]);

  const toggle = () => {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  // Map a pointer x within the track to a time and seek there.
  const seekTo = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !video || !isFinite(video.duration)) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setCurrent(video.currentTime);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    scrubbing.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    seekTo(e.clientX);
  };
  const onPointerUp = () => {
    scrubbing.current = false;
  };

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <Refract
      className="flex items-center gap-3 rounded-full px-3.5 pr-5 py-2 select-none"
      // Don't let scrub gestures bubble to the swipe/close handlers behind it.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        className="grid place-items-center rounded-full p-1 text-white/90 transition-colors hover:text-white"
      >
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>

      <span className="text-sm text-white/80 tabular-nums">
        {formatDuration(current)}
      </span>

      <div
        ref={trackRef}
        className="relative h-1.5 w-48 cursor-pointer rounded-full bg-white/25"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
          style={{ left: `${pct}%` }}
        />
      </div>

      <span className="text-sm text-white/80 tabular-nums">
        {formatDuration(duration)}
      </span>
    </Refract>
  );
}
