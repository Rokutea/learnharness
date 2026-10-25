"use client";
/**
 * COURSES (course mode, fork 2026-10-25): the settings section where the
 * learner registers course folders. A session started with a course picked
 * learns ONLY from that course's material — the agents search its PDFs and
 * Markdown files instead of the web, and its glossary keeps the lesson in
 * the course's terminology.
 *
 * One list, one add form. Each course row shows its index state, offers
 * re-index / glossary / delete, and opens an inline glossary editor (the
 * glossary is the learner's to correct — it is what the tutor treats as
 * the course's vocabulary). Live state arrives over the app's push
 * channel ("courses-changed" → refetch).
 */

import { useCallback, useEffect, useState } from "react";
import type { CourseListItem } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

const INPUT =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const LINK =
	"shrink-0 cursor-pointer text-xs text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted-foreground/40 disabled:no-underline";
const QUIET_LINK =
	"shrink-0 cursor-pointer text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:cursor-default disabled:text-muted-foreground/40 disabled:no-underline";

/** The desktop folder picker (Electron preload), absent in the browser. */
function folderPicker(): (() => Promise<string | null>) | null {
	if (typeof window === "undefined") return null;
	return (window as { lh?: { pickFolder?: () => Promise<string | null> } }).lh?.pickFolder ?? null;
}

async function errorOf(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Request failed (${res.status})`;
}

export function CoursesSection() {
	const [courses, setCourses] = useState<CourseListItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void fetch("/api/courses", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ courses: CourseListItem[] }>)
			.then((body) => setCourses(body.courses))
			.catch(() => setCourses((prev) => prev ?? []));
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("courses-changed", refresh);

	return (
		<div className="flex flex-col gap-4" data-testid="courses-section">
			<p className="text-xs text-muted-foreground">
				Pick a course when you start a session, and the tutor learns only from that course&apos;s material
				(PDF and Markdown files): no web search, your course&apos;s terms and notation, citations to file and page.
			</p>
			{error && (
				<p role="alert" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500" data-testid="courses-error">
					{error}
				</p>
			)}
			{courses === null ? (
				<p className="text-xs text-muted-foreground/70">Loading courses…</p>
			) : courses.length === 0 ? (
				<p className="text-xs text-muted-foreground/70" data-testid="courses-empty">
					No courses yet.
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{courses.map((c) => (
						<CourseRow key={c.id} course={c} onError={setError} />
					))}
				</ul>
			)}
			<AddCourse onError={setError} />
		</div>
	);
}

function AddCourse({ onError }: { onError: (e: string | null) => void }) {
	const [name, setName] = useState("");
	const [folder, setFolder] = useState("");
	const [glossary, setGlossary] = useState(true);
	const [busy, setBusy] = useState(false);
	const pick = folderPicker();

	const add = async () => {
		if (!folder.trim() || busy) return;
		setBusy(true);
		onError(null);
		try {
			const res = await fetch("/api/courses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.trim() || undefined, folder: folder.trim(), glossary }),
			});
			if (!res.ok) {
				onError(await errorOf(res));
				return;
			}
			setName("");
			setFolder("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 border-t border-border/60 pt-4" data-testid="course-add">
			<p className="text-xs uppercase tracking-widest text-muted-foreground">Add a course</p>
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Name (e.g. Control Systems I)"
					aria-label="Course name"
					data-testid="course-add-name"
					className={INPUT}
				/>
			</div>
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={folder}
					onChange={(e) => setFolder(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void add();
					}}
					placeholder="Folder with the course files, e.g. ~/Uni/ControlSystems"
					aria-label="Course folder"
					data-testid="course-add-folder"
					className={INPUT}
				/>
				{pick && (
					<button
						type="button"
						className={QUIET_LINK}
						data-testid="course-add-pick"
						onClick={() =>
							void pick().then((chosen) => {
								if (chosen) setFolder(chosen);
							})
						}
					>
						Choose…
					</button>
				)}
			</div>
			<label className="flex items-center gap-2 text-xs text-muted-foreground">
				<input
					type="checkbox"
					checked={glossary}
					onChange={(e) => setGlossary(e.target.checked)}
					data-testid="course-add-glossary"
				/>
				Build a glossary of the course&apos;s terms after indexing (uses your cheap model)
			</label>
			<div>
				<button type="button" className={LINK} disabled={busy || !folder.trim()} onClick={() => void add()} data-testid="course-add-submit">
					{busy ? "Adding…" : "Add course"}
				</button>
			</div>
		</div>
	);
}

function statusLine(c: CourseListItem): string {
	if (c.running === "index") return `Indexing${c.progress ? `: ${c.progress}` : "…"}`;
	if (c.running === "glossary") return `Building glossary${c.progress ? `: ${c.progress}` : "…"}`;
	if (!c.index) return "Not indexed yet";
	const parts = [
		`${c.index.fileCount} ${c.index.fileCount === 1 ? "file" : "files"}`,
		`${c.index.passageCount} pages/sections`,
		`indexed ${new Date(c.index.builtAt).toLocaleString()}`,
	];
	return parts.join(" · ");
}

function CourseRow({ course: c, onError }: { course: CourseListItem; onError: (e: string | null) => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const busy = c.running !== null;

	const post = async (url: string, body?: unknown) => {
		onError(null);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		if (!res.ok) onError(await errorOf(res));
		return res;
	};

	const generate = async () => {
		if (c.glossary?.edited && !window.confirm("Regenerating replaces your edits to this glossary. Continue?")) return;
		await post(`/api/courses/${c.id}/glossary`, { force: c.glossary?.edited === true });
	};

	const openEditor = async () => {
		if (editing) {
			setEditing(false);
			return;
		}
		const res = await fetch(`/api/courses/${c.id}`, { cache: "no-store" });
		if (!res.ok) {
			onError(await errorOf(res));
			return;
		}
		const body = (await res.json()) as { glossary: string | null };
		setText(body.glossary ?? "");
		setEditing(true);
	};

	const saveGlossary = async () => {
		onError(null);
		const res = await fetch(`/api/courses/${c.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ glossary: text }),
		});
		if (!res.ok) onError(await errorOf(res));
		else setEditing(false);
	};

	const remove = async () => {
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		onError(null);
		const res = await fetch(`/api/courses/${c.id}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) onError(await errorOf(res));
	};

	return (
		<li className="rounded-sm border border-border px-3 py-2" data-testid={`course-${c.id}`}>
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-prose text-(length:--lh-prose-size)">{c.name}</span>
				<span className="truncate font-mono text-[11px] text-muted-foreground/70" title={c.folder}>
					{c.folder}
				</span>
			</div>
			<p className="mt-1 text-xs text-muted-foreground" data-testid={`course-${c.id}-status`}>
				{statusLine(c)}
			</p>
			{!busy && c.index && (c.index.failedFiles.length > 0 || c.index.emptyPages > 0) && (
				<p className="mt-1 text-xs text-amber-500">
					{c.index.failedFiles.length > 0 && `${c.index.failedFiles.length} file(s) could not be read. `}
					{c.index.emptyPages > 0 && `${c.index.emptyPages} PDF page(s) have no text (likely scans) and cannot be searched.`}
				</p>
			)}
			{!busy && (
				<p className="mt-1 text-xs text-muted-foreground">
					{c.glossary
						? `Glossary: ${c.glossary.termCount} terms${c.glossary.edited ? " (edited by you)" : ""}`
						: "No glossary yet"}
				</p>
			)}
			{c.lastError && !busy && <p className="mt-1 text-xs text-red-500">{c.lastError}</p>}
			<div className="mt-2 flex flex-wrap items-center gap-3">
				<button type="button" className={QUIET_LINK} disabled={busy} onClick={() => void post(`/api/courses/${c.id}/index`)}>
					Re-index
				</button>
				<button type="button" className={QUIET_LINK} disabled={busy || !c.index} onClick={() => void generate()}>
					{c.glossary ? "Regenerate glossary" : "Build glossary"}
				</button>
				<button type="button" className={QUIET_LINK} disabled={busy || !c.glossary} onClick={() => void openEditor()}>
					{editing ? "Close glossary" : "Edit glossary"}
				</button>
				<button
					type="button"
					className="shrink-0 cursor-pointer text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
					onClick={() => void remove()}
					onBlur={() => setConfirmDelete(false)}
					data-testid={`course-${c.id}-delete`}
				>
					{confirmDelete ? "Click again to delete" : "Delete"}
				</button>
			</div>
			{editing && (
				<div className="mt-2 flex flex-col gap-2">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						aria-label={`${c.name} glossary`}
						rows={14}
						className="w-full rounded-sm border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/50"
					/>
					<div className="flex gap-3">
						<button type="button" className={LINK} onClick={() => void saveGlossary()}>
							Save glossary
						</button>
						<button type="button" className={QUIET_LINK} onClick={() => setEditing(false)}>
							Cancel
						</button>
					</div>
				</div>
			)}
		</li>
	);
}
