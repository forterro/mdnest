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
import { getTasks, patchTask, saveBoard } from '../api';
import BoardColumnsEditor from './BoardColumnsEditor';
import './TaskBoard.css';

// A task is identified across the UI by its source location, which is unique
// even when two items share the same text. The backend id is content-derived
// and can collide, so it is not used as a DnD key.
function cardKey(t) {
  return `${t.path}\u0000${t.line}`;
}

function TaskCard({ task, canWrite, onOpen }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: cardKey(task),
    data: { task },
    disabled: !canWrite,
  });
  return (
    <div
      ref={setNodeRef}
      className={`tb-card${isDragging ? ' dragging' : ''}${task.checked ? ' checked' : ''}`}
      {...(canWrite ? { ...attributes, ...listeners } : {})}
    >
      <div className="tb-card-text">{task.text || <em>(empty)</em>}</div>
      <button
        type="button"
        className="tb-card-source"
        title={`Open ${task.path}`}
        onClick={(e) => { e.stopPropagation(); onOpen(task.path); }}
      >
        {task.path}
      </button>
    </div>
  );
}

function BoardColumn({ column, tasks, canWrite, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canWrite });
  return (
    <div ref={setNodeRef} className={`tb-column${isOver ? ' over' : ''}`}>
      <div className="tb-column-head">
        <span className="tb-column-title">{column.title}</span>
        <span className="tb-column-count">{tasks.length}</span>
      </div>
      <div className="tb-column-body">
        {tasks.map((t) => (
          <TaskCard key={cardKey(t)} task={t} canWrite={canWrite} onOpen={onOpen} />
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
export default function TaskBoard({ ns, canWrite, onOpenNote, onClose }) {
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('mdnest_taskboard_mode') || 'board');
  const [editingColumns, setEditingColumns] = useState(false);
  const [activeTask, setActiveTask] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const reload = useCallback(async () => {
    if (!ns) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getTasks(ns);
      setBoard(data.board);
      setTasks(data.tasks || []);
    } catch (e) {
      setError(e.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [ns]);

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
    <div className="tb-overlay" role="dialog" aria-label="Task board">
      <div className="tb-header">
        <div className="tb-header-left">
          <strong className="tb-title">Tasks</strong>
          <span className="tb-ns">{ns}</span>
          <div className="tb-mode-toggle">
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setModePersist('list')}>List</button>
            <button className={mode === 'board' ? 'active' : ''} onClick={() => setModePersist('board')}>Board</button>
          </div>
        </div>
        <div className="tb-header-right">
          <button className="tb-btn" onClick={reload} title="Refresh">&#8635;</button>
          {canWrite && (
            <button className="tb-btn" onClick={() => setEditingColumns(true)} title="Edit columns">Columns…</button>
          )}
          <button className="tb-btn tb-close" onClick={onClose} title="Close" aria-label="Close">&times;</button>
        </div>
      </div>

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
