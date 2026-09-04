import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { studyFilename } from "../persist"
import { useStudyStore } from "../study/store"
import { ChevronDownIcon, DownloadIcon, UploadIcon } from "../ui/icons"

/**
 * Where am I, and what can I do with this project.
 *
 * WHY A BREADCRUMB
 *
 * The single word "study" never landed; people asked "is a study a project?" and "how do I make a
 * new one?". The breadcrumb answers both without a glossary: `Projects › invoicing` says this is
 * one project among several, and the first crumb is the way to the rest of them. Everything that
 * acts on the WHOLE project (rename, duplicate, export, import, delete) lives behind the name, so
 * the top bar can shrink to the things a person does every minute.
 */
export const ProjectMenu = () => {
  const study = useStudyStore((s) => s.study)
  const setHomeOpen = useStudyStore((s) => s.setHomeOpen)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <nav className="crumbs" aria-label="Project">
      <button className="crumb" onClick={() => setHomeOpen(true)} title="Every saved project: open, rename, duplicate or delete one.">
        Projects
      </button>
      <span className="crumb-sep" aria-hidden="true">
        {"\u203a"}
      </span>
      <div className="menu-anchor" ref={anchor}>
        <button
          className={`crumb crumb-current ${open ? "active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={study.problem || "This project. Rename, duplicate, export or delete it."}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
        >
          <strong>{study.name}</strong>
          <ChevronDownIcon size={12} className="tool-caret" />
        </button>
        {open && <ProjectPopover onClose={() => setOpen(false)} />}
      </div>
    </nav>
  )
}

const ProjectPopover = ({ onClose }: { onClose: () => void }) => {
  const study = useStudyStore((s) => s.study)
  const renameStudy = useStudyStore((s) => s.renameStudy)
  const duplicateStudy = useStudyStore((s) => s.duplicateStudy)
  const deleteOpenStudy = useStudyStore((s) => s.deleteOpenStudy)
  const exportStudyJson = useStudyStore((s) => s.exportStudyJson)
  const importStudyJson = useStudyStore((s) => s.importStudyJson)
  const [name, setName] = useState(study.name)
  const [problem, setProblem] = useState(study.problem)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const versions = study.candidates.length

  const submit = (e: FormEvent) => {
    e.preventDefault()
    renameStudy({ name, problem })
    onClose()
  }

  const download = useCallback(() => {
    // A PROJECT, not a design. The design alone would lose the rules, the bounds and every other
    // version -- which is to say it would lose the argument and keep only one of its conclusions.
    const blob = new Blob([exportStudyJson()], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = studyFilename(study)
    a.click()
    URL.revokeObjectURL(url)
    onClose()
  }, [exportStudyJson, study, onClose])

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    // Accepts a project OR a bare design; a design becomes a one-version project with no rules, which
    // is the honest treatment of a document that has none.
    importStudyJson(await file.text())
    event.target.value = ""
    onClose()
  }

  return (
    <div className="popover project-popover" role="dialog" aria-label="Project" onClick={(e) => e.stopPropagation()}>
      <form className="project-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="field">
          <span className="field-label">Problem</span>
          <textarea
            rows={3}
            value={problem}
            placeholder="What this system must do, in one or two sentences."
            onChange={(e) => setProblem(e.target.value)}
          />
        </label>
        <div className="project-form-actions">
          <span className="muted small tnum">
            {versions} version{versions === 1 ? "" : "s"}
          </span>
          <button className="btn primary small" type="submit" disabled={name.trim().length === 0}>
            Save
          </button>
        </div>
      </form>

      <div className="project-actions" role="group" aria-label="Project actions">
        <button
          className="menu-item"
          onClick={() => {
            duplicateStudy()
            onClose()
          }}
          title="Copy this project with its results cleared, so the copy's yardstick can change."
        >
          Duplicate
        </button>
        <button className="menu-item" onClick={download} title="Download the whole project: every version, the rules, the bounds.">
          <DownloadIcon size={13} />
          Export JSON
        </button>
        <button className="menu-item" onClick={() => fileRef.current?.click()} title="Open a project or a bare design from a JSON file.">
          <UploadIcon size={13} />
          Import JSON…
        </button>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => void importFile(e)} />
        {confirmDelete ? (
          <div className="confirm-row">
            <span className="small">Delete “{study.name}” and its {versions} version{versions === 1 ? "" : "s"}?</span>
            <button
              className="btn small danger"
              onClick={() => {
                void deleteOpenStudy()
                onClose()
              }}
            >
              Delete
            </button>
            <button className="btn small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </div>
        ) : (
          <button className="menu-item danger" onClick={() => setConfirmDelete(true)}>
            Delete project…
          </button>
        )}
      </div>
    </div>
  )
}
