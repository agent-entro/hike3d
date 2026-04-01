/**
 * App — root component. App shell layout:
 * - Left: SearchPanel
 * - Center: Viewport3D
 * - Bottom of center: ElevationProfile
 * useSession ensures an anonymous JWT session exists on load.
 */

import { useSession } from './hooks/useSession';
import { SearchPanel } from './components/SearchPanel';
import { Viewport3D } from './components/Viewport3D';
import { ElevationProfile } from './components/ElevationProfile';
import './index.css';

export default function App() {
  const { sessionId, loading, error } = useSession();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Left panel: trail search */}
      <SearchPanel />

      {/* Main content: 3D viewport + elevation profile stacked vertically */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Session status bar */}
        <div className="flex items-center justify-end px-4 py-1 bg-slate-900 border-b border-slate-700 text-xs">
          {loading && (
            <span className="text-slate-400">Initializing session…</span>
          )}
          {error && (
            <span className="text-red-400">Session error: {error}</span>
          )}
          {sessionId && !loading && (
            <span className="text-emerald-400">
              Session: {sessionId.slice(0, 8)}…
            </span>
          )}
        </div>

        {/* 3D Viewport (fills available height) */}
        <Viewport3D />

        {/* Elevation profile chart at bottom */}
        <ElevationProfile />
      </div>
    </div>
  );
}
