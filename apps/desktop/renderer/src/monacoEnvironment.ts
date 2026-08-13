import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

window.MonacoEnvironment = {
  getWorker: () => {
    const worker = new EditorWorker();
    worker.addEventListener('error', (event) => {
      console.error('Monaco worker error.', event.message);
    });
    return worker;
  },
};
