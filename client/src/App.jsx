/**
 * App — root component. App shell layout:
 * - Left: SearchPanel (trail search + results)
 * - Center: Viewport3D (3D terrain + trail overlay)
 * - Bottom of center: ElevationProfile (elevation chart)
 *
 * State managed here:
 *   - session: anonymous JWT session (useSession)
 *   - selectedTrail: the trail the user clicked in search results
 */

import { useState } from 'react';
import { useSession } from './hooks/useSession';
import { useTrail } from './hooks/useTrail';
import { SearchPanel } from './components/SearchPanel';
import { Viewport3D } from './components/Viewport3D';
import { ElevationProfile } from './components/ElevationProfile';
import './index.css';

export default function App() {
  const { sessionId, loading: sessionLoading, error: sessionError } = useSession();

  // trailSummary: the item clicked in search results (has id, name, basic stats)
  const [trailSummary, setTrailSummary] = useState(null);

  // useTrail fetches the full trail (GeoJSON, waypoints, elevation profile) from the API
  const { trail, loading: trailLoading, error: trailError } = useTrail(trailSummary);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Left panel: trail search */}
      <SearchPanel onSelectTrail={setTrailSummary} />

      {/* Main content: 3D viewport + elevation profile stacked vertically */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Status bar */}
        <div className="flex items-center justify-between px-4 py-1 bg-slate-900 border-b border-slate-700 text-xs">
          {/* Selected trail name */}
          <span className="text-slate-400 truncate">
            {trail
              ? trail.name
              : trailSummary
              ? trailLoading
                ? `Loading ${trailSummary.name}…`
                : 'No trail selected'
              : 'No trail selected'}
          </span>

          {/* Session status */}
          <span className="ml-4 shrink-0">
            {sessionLoading && <span className="text-slate-400">Initializing session…</span>}
            {sessionError && <span className="text-red-400">Session error: {sessionError}</span>}
            {sessionId && !sessionLoading && (
              <span className="text-emerald-400">Session: {sessionId.slice(0, 8)}…</span>
            )}
          </span>
        </div>

        {/* 3D Viewport — receives full trail data (with GeoJSON, waypoints, bbox) */}
        <Viewport3D trail={trail} loading={trailLoading} error={trailError} />

        {/* Elevation profile chart at bottom */}
        <ElevationProfile trail={trail} />
      </div>
    </div>
  );
}
