import { useEffect, useRef } from "react";

import { Search, X } from "lucide-react";

import IndexingPill from "./IndexingPill";
import PeoplePopover from "./PeoplePopover";
import Refract from "./Refract";

import { Person } from "@/lib/photoApi";

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
  /** Filter the gallery to a person picked in the People popover. */
  onPickPerson: (person: Person) => void;
  /** Resume the full-speed indexing screen (triggered from the indexing pill). */
  onResumeIndexing: () => void;
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
  onPickPerson,
  onResumeIndexing,
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
    <div className="pointer-events-none absolute top-3 right-5 z-30 flex items-center justify-end gap-4">
      <IndexingPill onResume={onResumeIndexing} />

      <PeoplePopover onPick={onPickPerson} />

      {/* The search field: a glass pill that transitions between two states, a
          circular icon button and a full search bar. Only the box geometry is
          toggled (the closed width is just the icon, the open width fits the
          field); the native liquid-glass spring on Refract animates the morph,
          and Refract regenerates its refraction map as the box grows so the
          lensing tracks the expanding pill. The icon stays put through the
          morph; the input is a flex child that the growing box makes room for,
          fading in as the space appears. */}
      <Refract
        className="top-0.75 pointer-events-auto flex items-center rounded-full h-11 px-1.5 font-sans"
        style={{ width: searchOpen ? 248 : 38 }}
      >
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
          className="min-w-0 flex-1 bg-transparent text-md text-white/90 outline-none placeholder:text-white/40 transition-opacity duration-300"
          style={{
            opacity: searchOpen ? 1 : 0,
            pointerEvents: searchOpen ? "auto" : "none",
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
      </Refract>
    </div>
  );
}
