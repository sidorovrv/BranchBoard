import type { TelemetryTile } from "@branchboard/core";

const groupsOf = (tiles: TelemetryTile[]): [string, TelemetryTile[]][] => {
  const groups = new Map<string, TelemetryTile[]>();
  tiles.forEach((tile) => groups.set(tile.group, [...(groups.get(tile.group) ?? []), tile]));
  return [...groups.entries()];
};

export const TelemetryTiles = ({ tiles }: { tiles: TelemetryTile[] }) => (
  <div className="telemetry-groups">
    {groupsOf(tiles).map(([group, groupTiles]) => (
      <section key={group} className="telemetry-group">
        <h5>{group}</h5>
        <div className="telemetry-tiles">
          {groupTiles.map((tile) => (
            <div key={tile.label} className="telemetry-tile">
              <div className="telemetry-tile-label">{tile.label}</div>
              <div className="telemetry-tile-value">{tile.value}</div>
            </div>
          ))}
        </div>
      </section>
    ))}
  </div>
);
