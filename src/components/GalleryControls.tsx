import { useEffect, useRef } from "react";

import { Search, Users, X } from "lucide-react";

import IndexingPill from "./IndexingPill";

interface GalleryControlsProps {
  /** Current text in the search field. */
  query: string;
  /** Whether the search field is expanded. */
  searchOpen: boolean;
  onQueryChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
  /** Run the search for the current query. */
  onSubmit: () => void;
  /** Clear the search and collapse the field. */
  onClear: () => void;
  /** Open the People view. */
  onOpenPeople: () => void;
}

/**
 * Top-right gallery controls: the indexing pill, a People button, and a search
 * field that grows out of a circular button.
 *
 * The row is pinned to the right with no fixed width, so when the search field
 * expands it grows leftward, nudging the pill and People button aside. The
 * field is controlled by the parent so opening the People view can drop a name
 * into it and run the search in one step.
 */
export default function GalleryControls({
  query,
  searchOpen,
  onQueryChange,
  onSearchOpenChange,
  onSubmit,
  onClear,
  onOpenPeople,
}: GalleryControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field whenever it opens (including when a person's name is
  // dropped into it from the People view).
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  const iconButton =
    "grid place-items-center rounded-full p-1.5 text-white/85 transition-colors hover:text-white";

  return (
    <div className="pointer-events-none absolute top-3 right-7 z-30 flex items-center justify-end gap-2">
      <IndexingPill />

      <button
        type="button"
        aria-label="People"
        onClick={onOpenPeople}
        className="pointer-events-auto grid h-10 w-10 place-items-center rounded-full frosted-glass text-white/85 transition-colors hover:text-white"
      >
        <Users size={18} />
      </button>

      {/* The search field: a frosted pill that starts as a circular button and
          grows as the input widens. No overflow:hidden here, because WebView2
          drops the backdrop-filter when a frosted element clips. */}
      <div className="pointer-events-auto flex h-10 items-center rounded-full frosted-glass px-1 font-sans">
        <button
          type="button"
          aria-label={searchOpen ? "Search" : "Open search"}
          onClick={() => (searchOpen ? onSubmit() : onSearchOpenChange(true))}
          className={iconButton}
        >
          <Search size={18} />
        </button>

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            else if (e.key === "Escape") onClear();
          }}
          placeholder="Search"
          tabIndex={searchOpen ? 0 : -1}
          className="bg-transparent text-sm text-white/90 outline-none placeholder:text-white/40 transition-[width,opacity,margin] duration-300"
          style={{
            width: searchOpen ? 176 : 0,
            opacity: searchOpen ? 1 : 0,
            marginRight: searchOpen ? 4 : 0,
          }}
        />

        {searchOpen && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={onClear}
            className={iconButton}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
