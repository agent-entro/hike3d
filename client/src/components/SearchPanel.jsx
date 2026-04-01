/**
 * SearchPanel — left panel for trail search.
 * Phase 2: live search with debounce, result cards with stats + difficulty badge.
 */

import { useSearch } from '../hooks/useSearch';

/**
 * @param {{ onSelectTrail: (trail: Object) => void }} props
 */
export function SearchPanel({ onSelectTrail }) {
  const { query, setQuery, results, loading, error } = useSearch();

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700 w-80 min-w-64 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700">
        <h1 className="text-lg font-semibold text-white">hike3d</h1>
        <p className="text-xs text-slate-400 mt-0.5">Search hiking trails worldwide</p>
      </div>

      {/* Search input */}
      <div className="px-4 py-3 border-b border-slate-700">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search trails (e.g. Half Dome)…"
            className="w-full px-3 py-2 bg-slate-800 text-white placeholder-slate-400 rounded-md border border-slate-600 focus:outline-none focus:border-emerald-500 text-sm pr-8"
          />
          {loading && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2">
              <LoadingSpinner size={14} />
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-400 mt-1">{error}</p>
        )}
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto">
        {loading && results.length === 0 && (
          <div className="px-4 py-6 space-y-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {!loading && results.length === 0 && query.trim().length >= 2 && !error && (
          <p className="text-slate-500 text-sm text-center mt-8 px-4">
            No trails found for "{query}".<br />
            <span className="text-xs text-slate-600 mt-1 block">
              Try a broader search or import a GPX file.
            </span>
          </p>
        )}

        {!loading && results.length === 0 && query.trim().length < 2 && (
          <p className="text-slate-500 text-sm text-center mt-8 px-4">
            Search for a trail to get started
          </p>
        )}

        {results.length > 0 && (
          <ul className="py-2 space-y-1">
            {results.map((trail) => (
              <TrailCard
                key={trail.id}
                trail={trail}
                onSelect={() => onSelectTrail?.(trail)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

function TrailCard({ trail, onSelect }) {
  const distKm = (trail.distance_m / 1000).toFixed(1);
  const gainM = trail.elevation_gain_m?.toLocaleString() ?? '—';

  return (
    <li>
      <button
        onClick={onSelect}
        className="w-full text-left px-4 py-3 hover:bg-slate-800 transition-colors border-b border-slate-800 group"
      >
        {/* Trail name */}
        <p className="text-sm font-medium text-white group-hover:text-emerald-400 truncate">
          {trail.name}
        </p>

        {/* Stats row */}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {trail.distance_m > 0 && (
            <Stat icon="↔" label={`${distKm} km`} />
          )}
          {trail.elevation_gain_m > 0 && (
            <Stat icon="↑" label={`${gainM} m`} />
          )}
          {trail.max_elev_m > 0 && (
            <Stat icon="▲" label={`${trail.max_elev_m.toLocaleString()} m`} />
          )}
          <DifficultyBadge difficulty={trail.difficulty} />
        </div>

        {/* Mini elevation sparkline */}
        {trail.elevation_profile?.length > 1 && (
          <ElevationSparkline profile={trail.elevation_profile} />
        )}
      </button>
    </li>
  );
}

function Stat({ icon, label }) {
  return (
    <span className="text-xs text-slate-400 flex items-center gap-0.5">
      <span className="text-slate-500">{icon}</span>
      {label}
    </span>
  );
}

const DIFFICULTY_COLORS = {
  easy: 'text-emerald-400 bg-emerald-400/10',
  moderate: 'text-yellow-400 bg-yellow-400/10',
  hard: 'text-orange-400 bg-orange-400/10',
  expert: 'text-red-400 bg-red-400/10',
};

function DifficultyBadge({ difficulty }) {
  if (!difficulty) return null;
  const colorClass = DIFFICULTY_COLORS[difficulty] ?? 'text-slate-400 bg-slate-400/10';
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium capitalize ${colorClass}`}>
      {difficulty}
    </span>
  );
}

/**
 * Tiny Canvas sparkline of the elevation profile.
 * ~50px tall, full width of the card.
 */
function ElevationSparkline({ profile }) {
  const canvasRef = (canvas) => {
    if (!canvas || !profile?.length) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const elevs = profile.map((p) => p.elevation_m);
    const minE = Math.min(...elevs);
    const maxE = Math.max(...elevs);
    const range = maxE - minE || 1;

    ctx.beginPath();
    for (let i = 0; i < elevs.length; i++) {
      const x = (i / (elevs.length - 1)) * width;
      const y = height - ((elevs[i] - minE) / range) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#10b981'; // emerald-500
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill area below line
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(16, 185, 129, 0.1)';
    ctx.fill();
  };

  return (
    <canvas
      ref={canvasRef}
      width={264}
      height={32}
      className="w-full mt-2 rounded opacity-80"
      aria-hidden="true"
    />
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse px-4 py-3 border-b border-slate-800">
      <div className="h-4 bg-slate-700 rounded w-3/4 mb-2" />
      <div className="flex gap-2">
        <div className="h-3 bg-slate-800 rounded w-12" />
        <div className="h-3 bg-slate-800 rounded w-16" />
        <div className="h-3 bg-slate-800 rounded w-10" />
      </div>
      <div className="h-8 bg-slate-800 rounded mt-2" />
    </div>
  );
}

function LoadingSpinner({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-spin text-emerald-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  );
}
