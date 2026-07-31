import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { getTasks, patchTask, saveBoard, createTask } from '../api';
import BoardColumnsEditor from './BoardColumnsEditor';
import './TaskBoard.css';

// A task is identified across the UI by its source location, which is unique
// even when two items share the same text. The backend id is content-derived
// and can collide, so it is not used as a DnD key.
function cardKey(t) {
  return `${t.path}\u0000${t.line}`;
}

const today = () => new Date().toISOString().slice(0, 10);

function TaskCard({ task, canWrite, onOpen, onToggleStep, onSetField, onSetText }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: cardKey(task),
    data: { task },
    disabled: !canWrite,
  });
  const [expanded, setExpanded] = useState(!!task.defaultExpanded);
  const steps = task.steps || [];
  const done = steps.filter((s) => s.checked).length;
  const hasDetail = steps.length > 0 || !!task.notes;
  const overdue = task.due && !task.checked && task.due < today();
  const noSwallow = (e) => e.stopPropagation();

  return (
    <div className={`tb-card${isDragging ? ' dragging' : ''}${task.checked ? ' checked' : ''}`} ref={setNodeRef}>
      {/* The head is the drag handle; interactive controls below stop propagation. */}
      <div className="tb-card-head" {...(canWrite ? { ...attributes, ...listeners } : {})}>
        {task.priority && (
          <span className={`tb-pri tb-pri-${String(task.priority).toLowerCase()}`}>{task.priority}</span>
        )}
        <span className="tb-card-text">{task.text || <em>(empty)</em>}</span>
      </div>

      {(task.due || task.workload || steps.length > 0) && (
        <div className="tb-card-meta">
          {task.due && <span className={`tb-due${overdue ? ' overdue' : ''}`} title="Due date">📅 {task.due}</span>}
          {task.workload && <span className="tb-chip" title="Workload">🏋 {task.workload}</span>}
          {steps.length > 0 && <span className="tb-chip" title="Steps done">☑ {done}/{steps.length}</span>}
        </div>
      )}

      {task.tags && task.tags.length > 0 && (
        <div className="tb-tags">{task.tags.map((t) => <span key={t} className="tb-tag">{t}</span>)}</div>
      )}

      {steps.length > 0 && (
        <div className="tb-progress"><div className="tb-progress-bar" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      )}

      {expanded && (
        <div className="tb-card-detail">
          {steps.length > 0 && (
            <ul className="tb-steps">
              {steps.map((s) => (
                <li key={s.line} className={s.checked ? 'checked' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={s.checked}
                      disabled={!canWrite}
                      onPointerDown={noSwallow}
                      onChange={() => onToggleStep(task, s)}
                    />
                    <span>{s.text || <em>(empty)</em>}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {task.notes && <div className="tb-notes">{task.notes}</div>}
          {canWrite && (
            <div className="tb-edit" onPointerDown={noSwallow}>
              <label>Title
                <input
                  key={task.text}
                  type="text"
                  defaultValue={task.text}
                  onKeyDown={(e) => { if (e.key === 'Enter') { onSetText(task, e.target.value); e.currentTarget.blur(); } }}
                  onBlur={(e) => onSetText(task, e.target.value)}
                />
              </label>
              <label>Priority
                <select value={task.priority || ''} onChange={(e) => onSetField(task, 'priority', e.target.value)}>
                  <option value="">—</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label>Due
                <input type="date" value={task.due || ''} onChange={(e) => onSetField(task, 'due', e.target.value)} />
              </label>
              <label>Tags
                <input
                  key={(task.tags || []).join(',')}
                  type="text"
                  defaultValue={(task.tags || []).join(', ')}
                  placeholder="a, b"
                  onKeyDown={(e) => { if (e.key === 'Enter') { onSetField(task, 'tags', e.target.value); e.currentTarget.blur(); } }}
                  onBlur={(e) => onSetField(task, 'tags', e.target.value)}
                />
              </label>
            </div>
          )}
        </div>
      )}

      <div className="tb-card-foot">
        {hasDetail && (
          <button type="button" className="tb-expand" onPointerDown={noSwallow}
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
            {expanded ? '▾ less' : '▸ more'}
          </button>
        )}
        <button type="button" className="tb-card-source" title={`Open ${task.path}`} onPointerDown={noSwallow}
          onClick={(e) => { e.stopPropagation(); onOpen(task.path); }}>
          {task.path}
        </button>
      </div>
    </div>
  );
}

function BoardColumn({ column, tasks, canWrite, onOpen, onToggleStep, onSetField, onSetText }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canWrite });
  return (
    <div ref={setNodeRef} className={`tb-column${isOver ? ' over' : ''}`}>
      <div className="tb-column-head">
        <span className="tb-column-title">{column.title}</span>
        <span className="tb-column-count">{tasks.length}</span>
      </div>
      <div className="tb-column-body">
        {tasks.map((t) => (
          <TaskCard key={cardKey(t)} task={t} canWrite={canWrite} onOpen={onOpen} onToggleStep={onToggleStep} onSetField={onSetField} onSetText={onSetText} />
        ))}
        {tasks.length === 0 && <div className="tb-column-empty">No tasks</div>}
      </div>
    </div>
  );
}

// TaskBoard is a namespace-level overlay presenting every markdown task-list
// item in the namespace, either as a flat list (with checkbox toggling) or as
// a kanban board (drag a card between columns). Both views project the same
// data — the notes themselves — so a change in one is reflected in the other.
export default function TaskBoard({ ns, canWrite, onOpenNote, onClose, currentPath }) {
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('mdnest_taskboard_mode') || 'board');
  const [editingColumns, setEditingColumns] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [scope, setScope] = useState('workspace');
  const [creating, setCreating] = useState(false);
  const [newText, setNewText] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newColumn, setNewColumn] = useState('');

  // The note-scoped view only makes sense with a note open.
  const effectiveScope = currentPath ? scope : 'workspace';

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const reload = useCallback(async () => {
    if (!ns) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getTasks(ns, effectiveScope === 'note' ? currentPath : undefined);
      setBoard(data.board);
      setTasks(data.tasks || []);
    } catch (e) {
      setError(e.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [ns, effectiveScope, currentPath]);

  useEffect(() => { reload(); }, [reload]);

  const setModePersist = useCallback((m) => {
    setMode(m);
    localStorage.setItem('mdnest_taskboard_mode', m);
  }, []);

  // Optimistically replace a task in local state after a successful mutation,
  // keyed by its (still-current) source location.
  const applyUpdated = useCallback((prevKey, updated) => {
    setTasks((cur) => cur.map((t) => (cardKey(t) === prevKey ? updated : t)));
  }, []);

  const handleToggle = useCallback(async (task) => {
    const key = cardKey(task);
    try {
      const updated = await patchTask(ns, task.path, {
        line: task.line,
        raw: task.raw,
        checked: !task.checked,
      });
      applyUpdated(key, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
    }
  }, [ns, applyUpdated, reload]);

  // Toggle a sub-task (step): flip its checkbox line. Optimistic, reconciled
  // from the step ack the backend returns (keeps the step's raw line fresh).
  const handleToggleStep = useCallback(async (task, step) => {
    const key = cardKey(task);
    setTasks((cur) => cur.map((t) => (cardKey(t) === key
      ? { ...t, steps: t.steps.map((s) => (s.line === step.line ? { ...s, checked: !s.checked } : s)) }
      : t)));
    try {
      const res = await patchTask(ns, task.path, { line: step.line, raw: step.raw, checked: !step.checked });
      if (res && res.step) {
        setTasks((cur) => cur.map((t) => (cardKey(t) === key
          ? { ...t, steps: t.steps.map((s) => (s.line === step.line ? { ...s, checked: res.checked, raw: res.raw } : s)) }
          : t)));
      } else {
        await reload();
      }
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message); await reload();
    }
  }, [ns, reload]);

  // Edit a single metadata field (priority/due/tags/...) inline.
  const handleSetField = useCallback(async (task, key, value) => {
    const k = cardKey(task);
    try {
      const updated = await patchTask(ns, task.path, { line: task.line, raw: task.raw, setField: { key, value } });
      applyUpdated(k, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
    }
  }, [ns, applyUpdated, reload]);

  // Edit a task (or step) title.
  const handleSetText = useCallback(async (task, text) => {
    const t = (text || '').trim();
    if (!t || t === task.text) return;
    const k = cardKey(task);
    try {
      const updated = await patchTask(ns, task.path, { line: task.line, raw: task.raw, text: t });
      applyUpdated(k, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
    }
  }, [ns, applyUpdated, reload]);

  // Create a task in the chosen note (or the board's default note).
  const handleCreate = useCallback(async () => {
    const text = newText.trim();
    if (!text) return;
    try {
      await createTask(ns, { text, note: newNote.trim() || undefined, column: newColumn || undefined });
      setNewText('');
      setCreating(false);
      await reload();
    } catch (e) {
      setError(e.message);
    }
  }, [ns, newText, newNote, newColumn, reload]);

  const handleDragStart = useCallback((event) => {
    setActiveTask(event.active?.data?.current?.task || null);
  }, []);

  const handleDragEnd = useCallback(async (event) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const task = active.data?.current?.task;
    if (!task || task.column === over.id) return;
    const key = cardKey(task);
    // Optimistic move so the card lands instantly.
    setTasks((cur) => cur.map((t) => (cardKey(t) === key ? { ...t, column: over.id } : t)));
    try {
      const updated = await patchTask(ns, task.path, {
        line: task.line,
        raw: task.raw,
        toColumn: over.id,
      });
      applyUpdated(key, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
      await reload();
    }
  }, [ns, applyUpdated, reload]);

  const columns = board?.columns || [];

  const tasksByColumn = useMemo(() => {
    const map = {};
    for (const c of columns) map[c.id] = [];
    for (const t of tasks) {
      (map[t.column] || (map[t.column] = [])).push(t);
    }
    return map;
  }, [columns, tasks]);

  const tasksByNote = useMemo(() => {
    const groups = new Map();
    for (const t of tasks) {
      if (!groups.has(t.path)) groups.set(t.path, []);
      groups.get(t.path).push(t);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks]);

  return (
    <div className="tb-panel" role="region" aria-label="Task board">
      <div className="tb-header">
        <div className="tb-header-left">
          <div className="tb-mode-toggle">
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setModePersist('list')}>List</button>
            <button className={mode === 'board' ? 'active' : ''} onClick={() => setModePersist('board')}>Kanban</button>
          </div>
          {currentPath && (
            <div className="tb-mode-toggle">
              <button className={effectiveScope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')} title="All notes in the workspace">Workspace</button>
              <button className={effectiveScope === 'note' ? 'active' : ''} onClick={() => setScope('note')} title="Only the current note">This note</button>
            </div>
          )}
        </div>
        <div className="tb-header-right">
          {canWrite && (
            <button className="tb-btn" onClick={() => {
              setNewNote(board?.defaultNote || (effectiveScope === 'note' ? currentPath : '') || '');
              setNewColumn('');
              setCreating(true);
            }} title="New task">+ New task</button>
          )}
          <button className="tb-btn" onClick={reload} title="Refresh">&#8635;</button>
          {canWrite && (
            <button className="tb-btn" onClick={() => setEditingColumns(true)} title="Edit columns">Columns…</button>
          )}
        </div>
      </div>
      {creating && (
        <div className="tb-new-task">
          <input
            className="tb-new-text"
            autoFocus
            placeholder="Task title"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
          />
          <input
            className="tb-new-note"
            placeholder={board?.defaultNote ? `note (default: ${board.defaultNote})` : 'note (e.g. tasks.md)'}
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            list="tb-note-list"
          />
          <datalist id="tb-note-list">
            {[...new Set(tasks.map((t) => t.path))].map((p) => <option key={p} value={p} />)}
          </datalist>
          <select className="tb-new-col" value={newColumn} onChange={(e) => setNewColumn(e.target.value)}>
            <option value="">column…</option>
            {(board?.columns || []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <button className="tb-btn primary" onClick={handleCreate} disabled={!newText.trim()}>Add</button>
          <button className="tb-btn" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {error && <div className="tb-error">{error}</div>}

      {loading ? (
        <div className="tb-loading">Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="tb-empty">No task-list items found in this namespace. Add <code>- [ ] something</code> to a note.</div>
      ) : mode === 'board' ? (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveTask(null)}
        >
          <div className="tb-board">
            {columns.map((col) => (
              <BoardColumn
                key={col.id}
                column={col}
                tasks={tasksByColumn[col.id] || []}
                canWrite={canWrite}
                onOpen={onOpenNote}
                onToggleStep={handleToggleStep}
                onSetField={handleSetField}
                onSetText={handleSetText}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? (
              <div className="tb-card dragging-overlay">
                <div className="tb-card-text">{activeTask.text || '(empty)'}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="tb-list">
          {tasksByNote.map(([notePath, items]) => (
            <div className="tb-list-group" key={notePath}>
              <button className="tb-list-note" onClick={() => onOpenNote(notePath)} title={`Open ${notePath}`}>
                {notePath}
              </button>
              <ul className="tb-list-items">
                {items.map((t) => (
                  <li key={cardKey(t)} className={t.checked ? 'checked' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={t.checked}
                        disabled={!canWrite}
                        onChange={() => handleToggle(t)}
                      />
                      <span className="tb-list-text">{t.text || <em>(empty)</em>}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {editingColumns && (
        <BoardColumnsEditor
          board={board}
          onCancel={() => setEditingColumns(false)}
          onSave={async (next) => {
            try {
              const saved = await saveBoard(ns, next);
              setBoard(saved);
              setEditingColumns(false);
              await reload();
            } catch (e) {
              setError(e.message);
            }
          }}
        />
      )}
    </div>
  );
}
