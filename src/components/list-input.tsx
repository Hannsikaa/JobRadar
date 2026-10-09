"use client";

import { useEffect, useRef, useState } from "react";

import { listToText, textToList } from "@/lib/profile/review";

/**
 * A comma-separated list field that can actually be typed into.
 *
 * The previous implementation derived the input's value from the parsed list on
 * every keystroke (`value={listToText(list)}` plus `onChange={textToList}`). That
 * round trip is lossy in the middle of a word: `textToList("English,")` drops the
 * trailing comma and `textToList("English ")` trims the trailing space, so the
 * comma or space a person just typed vanished before they finished the entry.
 * It was impossible to type `English, Spanish, Hindi` — the first comma never
 * survived long enough to reach the second word.
 *
 * This component fixes that by keeping the *raw text* in local state while the
 * field is focused, and only normalizing it on blur. The parsed list still flows
 * up on every change, so validation and the saved payload stay live; the display
 * simply does not re-derive itself out from under the cursor.
 *
 * Re-sync rules:
 * - It seeds from `value` on mount and whenever `value` changes to something
 *   this field did not just emit — that is how a server-normalized copy (after
 *   save) or a freshly loaded profile reaches the box.
 * - A keystroke changes `value` upstream on every character, but the parsed
 *   list it sends up serializes back to what is on screen (modulo the trailing
 *   comma/space still being typed), so the guard recognises its own echo and
 *   leaves the caret alone. Comparing the serialized forms — rather than only
 *   checking focus — means no upstream re-render can overwrite in-progress text,
 *   even one that happens in the same commit as the keystroke.
 */
export type ListInputProps = {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
  /** id of the hint or error text that belongs to this field. */
  describedBy?: string;
  invalid?: boolean;
};

export function ListInput({
  id,
  value,
  onChange,
  placeholder,
  className,
  describedBy,
  invalid = false,
}: ListInputProps) {
  const [text, setText] = useState(() => listToText(value));
  const focused = useRef(false);
  /** The serialized list this field last put on screen, however it got there. */
  const lastValue = useRef(listToText(value));

  useEffect(() => {
    const incoming = listToText(value);

    // Our own edit echoing back: leave what is being typed untouched.
    if (incoming === lastValue.current) {
      return;
    }

    lastValue.current = incoming;

    // A genuinely external change (a load or a server-normalized save). Only
    // take it while the field is not being typed into.
    if (!focused.current) {
      setText(incoming);
    }
  }, [value]);

  return (
    <input
      id={id}
      type="text"
      value={text}
      placeholder={placeholder}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        // Normalize what is on screen to match what the parent will hold, so a
        // trailing comma or stray space does not linger after the field is left.
        const normalized = listToText(textToList(text));
        lastValue.current = normalized;
        setText(normalized);
        onChange(textToList(text));
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const parsed = textToList(raw);
        // Record what the parent will serialize this to, so the effect above
        // can tell our own echo apart from a real external change.
        lastValue.current = listToText(parsed);
        onChange(parsed);
      }}
      className={className}
    />
  );
}
