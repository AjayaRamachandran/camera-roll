import { useState } from "react";

import { FolderOpen, Images } from "lucide-react";

import Refract from "./Refract";
import { pickFolder, restartBackend } from "@/lib/api";
import { addLibrary, setIndexesRoot } from "@/lib/photoApi";

interface LibrarySetupProps {
  /** Which first-run step to show. */
  step: "index_root" | "library";
  /** Re-check the setup state after the data folder has been chosen. */
  onRootChosen: () => void;
}

/**
 * First-run setup. Two steps, shown one at a time:
 *   1. Pick a folder where the app keeps everything it builds for fast browsing.
 *   2. Add the first photo folder to view.
 *
 * Adding the library restarts the backend so it opens the new folder, then the
 * window reloads into the normal preparing screen. Copy is plain and never
 * mentions indexes, scans, or the backend (see AGENTS.md).
 */
export default function LibrarySetup({ step, onRootChosen }: LibrarySetupProps) {
  const [busy, setBusy] = useState(false);

  const chooseRoot = async () => {
    const path = await pickFolder("Choose where to keep your library data");
    if (!path) return;
    setBusy(true);
    try {
      await setIndexesRoot(path);
      onRootChosen();
    } catch {
      setBusy(false);
    }
  };

  const addFirstLibrary = async () => {
    const path = await pickFolder("Choose your photo folder");
    if (!path) return;
    setBusy(true);
    try {
      await addLibrary(path);
      await restartBackend();
      // Reload into the normal preparing screen; the fresh backend opens the
      // new library and starts getting it ready.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  const content =
    step === "index_root"
      ? {
          icon: <FolderOpen size={26} />,
          title: "Welcome to Camera Roll",
          body: "Choose a folder where Camera Roll can keep everything it builds to show your photos quickly.",
          action: "Choose folder",
          onClick: chooseRoot,
        }
      : {
          icon: <Images size={26} />,
          title: "Add your photos",
          body: "Choose the folder where your photos live. You can add more libraries later.",
          action: "Choose photo folder",
          onClick: addFirstLibrary,
        };

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex w-96 flex-col items-center gap-5 text-center font-sans">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-(--frost-text)">
          {content.icon}
        </div>

        <p className="text-(--frost-text) text-lg">{content.title}</p>
        <p className="text-(--frost-text-dim) text-sm leading-relaxed">{content.body}</p>

        <Refract className="pointer-events-auto mt-1 rounded-full">
          <button
            type="button"
            onClick={content.onClick}
            disabled={busy}
            className="px-5 py-2.5 text-(--frost-text) text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Just a moment..." : content.action}
          </button>
        </Refract>
      </div>
    </div>
  );
}
