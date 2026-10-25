/**
 * CourseStore — the fs adapter for course mode (fork feature, 2026-10-25).
 *
 * Layout under PATHS.courses (data/courses/):
 *   courses.json          the course rows, one JSON array (read-modify-write)
 *   <id>/index.json       the extracted-text index (rewritten whole per build)
 *   <id>/glossary.md      the course glossary (generated, then user-editable)
 *
 * Implements core/ports.ts CourseStore; same idioms as the chat store:
 * sync fs, id-guarded paths, tab-indented JSON. Wired in the composition
 * root (src/server/stores.ts); the course service is the only writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { CoursePatch, CourseStore } from "../core/ports.ts";
import type { Course, CourseIndex } from "../core/contracts.ts";

const COURSES_FILE = () => path.join(PATHS.courses, "courses.json");

function courseDir(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(PATHS.courses, id);
}

function readAll(): Course[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(COURSES_FILE(), "utf-8")) as unknown;
		return Array.isArray(parsed) ? (parsed as Course[]) : [];
	} catch {
		return [];
	}
}

function writeAll(courses: Course[]): void {
	fs.mkdirSync(PATHS.courses, { recursive: true });
	fs.writeFileSync(COURSES_FILE(), JSON.stringify(courses, null, "\t"), "utf-8");
}

function listCourses(): Course[] {
	return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

function getCourse(id: string): Course | null {
	return readAll().find((c) => c.id === id) ?? null;
}

function createCourse(init: { name: string; folder: string }): Course {
	const now = new Date().toISOString();
	const course: Course = {
		id: `course_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		name: init.name.trim() || "Untitled course",
		folder: init.folder,
		createdAt: now,
		updatedAt: now,
	};
	writeAll([...readAll(), course]);
	return course;
}

function updateCourse(id: string, patch: CoursePatch): Course | null {
	const all = readAll();
	const at = all.findIndex((c) => c.id === id);
	if (at === -1) return null;
	const next: Course = { ...all[at]!, ...patch, updatedAt: new Date().toISOString() };
	// An explicit undefined clears the key (JSON drops it on write anyway;
	// deleting keeps the in-memory twin honest).
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
	}
	all[at] = next;
	writeAll(all);
	return next;
}

function deleteCourse(id: string): boolean {
	const all = readAll();
	const remaining = all.filter((c) => c.id !== id);
	if (remaining.length === all.length) return false;
	writeAll(remaining);
	fs.rmSync(courseDir(id), { recursive: true, force: true });
	return true;
}

function readIndex(id: string): CourseIndex | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(courseDir(id), "index.json"), "utf-8")) as CourseIndex;
	} catch {
		return null;
	}
}

function writeIndex(id: string, index: CourseIndex): void {
	const dir = courseDir(id);
	fs.mkdirSync(dir, { recursive: true });
	// Write-then-rename: a reader never sees a half-written index.
	const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(index), "utf-8");
	fs.renameSync(tmp, path.join(dir, "index.json"));
}

function readGlossary(id: string): string | null {
	try {
		return fs.readFileSync(path.join(courseDir(id), "glossary.md"), "utf-8");
	} catch {
		return null;
	}
}

function writeGlossary(id: string, markdown: string): void {
	const dir = courseDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "glossary.md"), markdown, "utf-8");
}

export const courseStore: CourseStore = {
	listCourses,
	getCourse,
	createCourse,
	updateCourse,
	deleteCourse,
	readIndex,
	writeIndex,
	readGlossary,
	writeGlossary,
};
