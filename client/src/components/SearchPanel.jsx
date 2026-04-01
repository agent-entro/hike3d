/**
 * SearchPanel — left panel for trail search.
 * Phase 1: shell only. Search logic wired in Phase 2.
 */

export function SearchPanel() {
  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700 w-80 min-w-64 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700">
        <h1 className="text-lg font-semibold text-white">hike3d</h1>
        <p className="text-xs text-slate-400 mt-0.5">Search hiking trails worldwide</p>
      </div>

      {/* Search input */}
      <div className="px-4 py-3 border-b border-slate-700">
        <input
          type="text"
          placeholder="Search trails (e.g. Half Dome)…"
          className="w-full px-3 py-2 bg-slate-800 text-white placeholder-slate-400 rounded-md border border-slate-600 focus:outline-none focus:border-emerald-500 text-sm"
          disabled
        />
        <p className="text-xs text-slate-500 mt-1">Trail search coming in Phase 2</p>
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-slate-500 text-sm text-center mt-8">
          Search for a trail to get started
        </p>
      </div>
    </div>
  );
}
