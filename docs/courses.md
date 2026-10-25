# Course mode

Added 2026-10-25 (fork). A session linked to a course learns from that
course's own material — lecture slides, the script, exercise sheets, old
exams — so the lesson uses the course's terms, notation and language, and
the learner studies what the exam will ask.

## Using it

1. **Settings → Courses → Add a course.** Name it and point it at the
   folder that holds the course files (desktop: "Choose…"). Supported:
   `.pdf`, `.md`, `.markdown`, `.txt`. Subfolders are included; dot-files,
   `node_modules` and the like are skipped. Indexing starts at once.
2. **Glossary.** With the checkbox on (the default), a glossary of the
   course's terms is built after indexing, using the cheap model slot. It
   is plain markdown and editable in the same section ("Edit glossary").
   Edits are kept: regenerating asks first.
3. **Start a session with the course picked.** The graduation-cap pill in
   the new-session action row picks the course; the last choice is
   remembered per device. The session's course is fixed for its life and
   shows in the session header.
4. **Re-index** after adding or changing files. Unchanged files (same size
   and modification time) are not re-read.

Scanned PDFs have no text layer: their pages index as empty and the course
row warns about them. The teacher can still look at such a page through
the `pdf` tool, which renders it for the vision model.

## What changes in a course session

| | Ordinary session | Course session |
|---|---|---|
| File tools | `read` / `ls` / `find` / `grep` over the home directory | `course_files` / `course_search` / `course_read` over the course index |
| `research` | web researcher (search + fetch) | course researcher (course tools only, no network); sources are `file://` links to the pages it read |
| `pdf` | any path | paths inside the course folder only |
| Prompt | `shared/30-learner-files.md` | `shared/35-course-grounding.md` + the course context (name, file list, glossary) |

The grounding fragment is **course-first, not course-only**: the course is
the authority on what is true and what things are called, the tutor looks
up before it plans, teaches, quizzes or poses a problem, cites file and page,
teaches in the course's language, and labels any explanation that goes
beyond the material. Where the course is silent it says so and asks before
continuing. Like every prompt segment, it is visible and overridable in
Settings → Agent.

Prober, teacher and practice agents all switch. The probe→teach handoff,
the graph, extraction and compaction are unchanged.

## How it works

- **Index** (`src/agent/courses/indexer.ts`): one passage per PDF page
  (pdfjs text layer, `pdfPageTexts`) and per markdown section
  (`chunkMarkdown`: split at headings, ~300–4000 chars, labelled
  `§ N (lines a–b)`). Stored as `data/courses/<id>/index.json`.
- **Search** (`src/core/course-search.ts`, pure): BM25 over passages with
  case/accent folding (ß → ss) and compound partials (a 4+ letter term
  also matches longer tokens containing it, at half weight — "funktion"
  finds "Übertragungsfunktion"), plus a phrase boost. No embeddings, no
  model, deterministic. The glossary is searchable as the pseudo-file
  `(course glossary)`.
- **Glossary** (`src/agent/subagents/course-glossary.ts`): the index in
  ~24k-character batches → the `glossaryMaker` role (cheap slot) submits
  `{term, definition, notation?, source}` per batch → merged by folded
  term (first definition wins). The prompt carries up to 16k characters
  of it; the rest stays reachable through `course_search`.
- **Service** (`src/server/courses.ts`): the only writer of course state.
  Runs are single-flight per course and push `courses-changed` events.
  `courseRuntimeFor(courseId)` builds what the tools close over; the chat
  handler and job runner resolve it from `ChatRecord.courseId`.

## API

| Method | Route | |
|---|---|---|
| GET | `/api/courses` | list with index/glossary summaries and live run state |
| POST | `/api/courses` | `{name?, folder, glossary?}` → 201, indexing starts |
| GET | `/api/courses/:id` | course, glossary markdown, file summary |
| PATCH | `/api/courses/:id` | `{name?, folder?, glossary?}`; a new folder re-indexes |
| DELETE | `/api/courses/:id` | 204 |
| POST | `/api/courses/:id/index` | re-index → 202 |
| POST | `/api/courses/:id/glossary` | `{force?}` → 202; 409 if edited without `force` |
| POST | `/api/chats` | accepts `courseId`; 400 for an unknown course |

## Limits and next steps

- Formats beyond PDF and Markdown/text (PowerPoint, Word, images with OCR)
  are not indexed yet. The indexer's `courseFileKind` / `readCourseFile`
  is the seam for adding them.
- Keyword search finds the course's wording, not paraphrases. The
  grounding prompt tells the agent to retry with the course's terms and
  the glossary supplies them; embeddings would be the next step if recall
  falls short.
- A model still knows things the course doesn't say. The design narrows
  this (no web, mandatory lookup, citations, labelled extras) rather than
  claiming to remove it.
