import { RotateCw } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { isChunkError, reloadForUpdate } from '../lib/update';
import { cls } from './hooks';

interface Props {
  children: ReactNode;
  /** Classes for the fallback, so it takes the place of the view it replaces. */
  className?: string;
  /** A change here (for example the mode) clears the error and tries again. */
  resetKey?: unknown;
}

interface State {
  error: unknown;
}

/**
 * Keeps one failing view from blanking the whole app. When the failure is a
 * build file that no longer exists (a new version was deployed), the page
 * reloads itself once; otherwise the listener gets a short note and a button.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: unknown) {
    if (isChunkError(error) && reloadForUpdate()) return;
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const update = isChunkError(error);
    return (
      <div className={cls('crash', this.props.className)} role="alert">
        <p className="crash-title">{update ? 'Musiccus baru saja diperbarui' : 'Bagian ini gagal dimuat'}</p>
        <p className="crash-note">
          {update
            ? 'Muat ulang halaman untuk memakai versi terbaru.'
            : 'Bagian lain tetap berjalan. Muat ulang halaman untuk mencoba lagi.'}
        </p>
        <button className="btn small" onClick={() => location.reload()}>
          <RotateCw size={13} aria-hidden="true" />
          Muat ulang
        </button>
      </div>
    );
  }
}
