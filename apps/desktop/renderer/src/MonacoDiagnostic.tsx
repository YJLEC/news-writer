import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';

type MonacoStatus = 'loading' | 'ready' | 'error';

export const MonacoDiagnostic = (): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MonacoStatus>('loading');

  useEffect(() => {
    const container = containerRef.current;
    const environment = window.MonacoEnvironment;
    if (!container || !environment) {
      setStatus('error');
      return;
    }

    const model = monaco.editor.createModel(
      'News Writer Monaco worker diagnostic',
      'plaintext',
      monaco.Uri.parse('inmemory://news-writer/diagnostic.txt'),
    );
    const editor = monaco.editor.create(container, {
      automaticLayout: false,
      model,
      readOnly: true,
    });
    const webWorker = monaco.editor.createWebWorker({
      worker: environment.getWorker('', 'editorWorkerService'),
    });
    let disposed = false;

    void webWorker.withSyncedResources([model.uri]).then(
      () => {
        if (!disposed) {
          setStatus('ready');
        }
      },
      (error: unknown) => {
        if (!disposed) {
          console.error('Monaco worker initialization failed.', error);
          setStatus('error');
        }
      },
    );

    return () => {
      disposed = true;
      webWorker.dispose();
      editor.dispose();
      model.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="monaco-diagnostic"
      data-monaco-status={status}
      aria-hidden="true"
    />
  );
};
