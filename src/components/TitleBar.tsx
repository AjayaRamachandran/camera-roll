import { useState, useEffect } from "react";

import { Square, Copy, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import Icon from "@/assets/icon.png";
import ProgramData from "@/assets/program-data.json";

// The window is frameless (decorations disabled in tauri.conf.json), so this
// component is the entire title bar. It owns dragging (via the
// `data-tauri-drag-region` attribute) and the minimize / maximize / close
// controls, wired to the native Tauri window. macOS is intentionally not
// supported here. Styled with Tailwind; the one shared CSS bit is the
// --titlebar-height variable (defined in global.css, reused by .app-content).
const appWindow = getCurrentWindow();

// Shared layout + look for the three window-control buttons. Per-button hover
// colors are appended at the call site (neutral for min/max, red for close).
const controlButton =
  "grid h-full w-[30px] cursor-pointer place-items-center border-0 bg-transparent p-0 text-white/55 transition-colors duration-[120ms]";

interface TitleBarProps {
  title?: string;
}

function TitleBar({ title = `${ProgramData.name}` }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  // Keep the maximize/restore icon in sync with the actual window state.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => unlisten?.();
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-100 flex h-(--titlebar-height) select-none items-center border-b border-white/6 bg-white/5 backdrop-blur-lg font-sans">
      {/* Full-width drag handle behind everything. Empty space drags the window. */}
      <div className="absolute inset-0 z-0" data-tauri-drag-region />

      {/* Icon + title. pointer-events-none lets clicks fall through to the drag
          zone so the labelled area stays draggable. */}
      <div className="pointer-events-none relative z-10 flex items-center gap-2 pl-3">
        <img
          src={Icon}
          alt=""
          aria-hidden="true"
          className="h-4 w-4 flex-none object-contain"
        />
        <div className="text-[12.5px] leading-none text-white/55">{title}</div>
      </div>

      {/* Window controls sit above the drag zone so they receive clicks. */}
      <div
        className="relative z-20 ml-auto flex h-full"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className={`${controlButton} hover:bg-white/8 hover:text-white/90`}
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <Minus size={13} />
        </button>
        <button
          className={`${controlButton} hover:bg-white/8 hover:text-white/90`}
          onClick={() => appWindow.toggleMaximize()}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <Copy size={12} style={{ transform: "rotate(90deg)" }} />
          ) : (
            <Square size={11} />
          )}
        </button>
        <button
          className={`${controlButton} hover:bg-[#c42b1c] hover:text-white`}
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          <X size={15} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}

export default TitleBar;
