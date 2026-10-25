"use client";

import type { ReactNode } from "react";
import { DumbbellIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead
 * (the course pill first — course mode, fork 2026-10-25); setup is
 * centered only when it is the sole action. */
export function ComposerActions({ picker, course, setup }: { picker?: ReactNode; course?: ReactNode; setup?: ReactNode }) {
	if (!picker && !course && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker || course ? "justify-start" : "justify-center"}`}
		>
			{course}
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
