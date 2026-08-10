const History = {
  undoStack: [],
  redoStack: [],
  push(cmd) {
    cmd.redo();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    onHistoryChange();
  },
  undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    onHistoryChange();
  },
  redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    c.redo();
    this.undoStack.push(c);
    onHistoryChange();
  },
};

function onHistoryChange() {
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  if (btnUndo) btnUndo.disabled = History.undoStack.length === 0;
  if (btnRedo) btnRedo.disabled = History.redoStack.length === 0;
}

export default History;
