import { RoomPositionSet } from 'lib/Utils/RoomPositionSet';
import { memoize } from 'lib/Utils/memoize';
import { fromGlobalPosition, globalPosition } from 'utils/packPositions';
import { MoveTarget } from '..';
import { offsetRoomPosition, sameRoomPosition } from './roomPositions';

/**
 * Position is an edge tile
 */
export const isExit = (pos: RoomPosition) => pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;

/**
 * Takes a target or list of targets in a few different possible formats and
 * normalizes to a list of MoveTarget[]
 */
export const normalizeTargets = memoize(
  (
    targets: _HasRoomPosition | RoomPosition | MoveTarget | RoomPosition[] | MoveTarget[],
    keepTargetInRoom = true,
    flee = false
  ) => {
    let key = `${keepTargetInRoom}${flee}`;
    if (Array.isArray(targets)) {
      if (targets.length && 'pos' in targets[0]) {
        key += (targets as MoveTarget[]).map(t => `${t.pos.__packedPos}_${t.range}`).join(',');
      } else {
        key += (targets as RoomPosition[]).map(t => t.__packedPos).join(',');
      }
    } else if ('pos' in targets) {
      if ('range' in targets) {
        key += `${targets.pos.__packedPos}_${targets.range}`;
      } else {
        key += `${targets.pos.__packedPos}_1`;
      }
    } else {
      key += `${targets.__packedPos}_1`;
    }
    return key;
  },
  (
    targets: _HasRoomPosition | RoomPosition | MoveTarget | RoomPosition[] | MoveTarget[],
    keepTargetInRoom = true,
    flee = false
  ) => {
    let normalizedTargets: MoveTarget[] = [];
    if (Array.isArray(targets)) {
      if (targets.length && 'pos' in targets[0]) {
        normalizedTargets.push(...(targets as MoveTarget[]));
      } else {
        normalizedTargets.push(...(targets as RoomPosition[]).map(pos => ({ pos, range: 0 })));
      }
    } else if ('pos' in targets) {
      if ('range' in targets) {
        normalizedTargets.push(targets);
      } else {
        normalizedTargets.push({ pos: targets.pos, range: 1 });
      }
    } else {
      normalizedTargets.push({ pos: targets, range: 1 });
    }

    if (keepTargetInRoom) normalizedTargets = normalizedTargets.flatMap(fixEdgePosition);

    if (flee) {
      // map flee targets to MoveTarget[] around perimeter of target areas
      const borders = new RoomPositionSet();
      // visualize normalized targets
      for (const { pos, range } of normalizedTargets) {
        calculatePositionsAtRange(pos, range + 1)
          .filter(p => {
            if (!isPositionWalkable(p, true, false)) return false;
            if (keepTargetInRoom && (p.roomName !== pos.roomName || isExit(p))) return false;
            return true;
          })
          .forEach(p => borders.add(p));
      }
      for (const pos of borders) {
        if (normalizedTargets.some(t => t.pos.inRangeTo(pos, t.range))) {
          borders.delete(pos);
        }
      }
      normalizedTargets = [...borders].map(pos => ({ pos, range: 0 }));
    }
    return normalizedTargets;
  }
);

/**
 * If a MoveTarget's position and range overlaps a room edge, this will split
 * the MoveTarget into two or four MoveTargets to cover an equivalent area without
 * overlapping the edge. Useful for pathing in range of a target, but making sure it's
 * at least in the same room.
 */
export function fixEdgePosition({ pos, range }: MoveTarget): MoveTarget[] {
  if (range === 0 || (pos.x > range && 49 - pos.x > range && pos.y > range && 49 - pos.y > range)) {
    return [{ pos, range }]; // no action needed
  }
  // generate quadrants
  const rect = {
    x1: Math.max(1, pos.x - range),
    x2: Math.min(48, pos.x + range),
    y1: Math.max(1, pos.y - range),
    y2: Math.min(48, pos.y + range)
  };
  const xdiff = rect.x2 - rect.x1 + 1; // width of the rect (inclusive)
  const ydiff = rect.y2 - rect.y1 + 1; // height of the rect (inclusive)

  // each square will have a center pos and a range that yields bounds
  // as close as possible to the min dimension of the rect
  const subsetRange = Math.floor((Math.min(xdiff, ydiff) - 1) / 2);

  // lay out a grid of squares that fills the rect as efficiently as possible
  // the last square in the row and/or column, if it doesn't fill the space
  // completely, will be shifted back to avoid overlapping the edge of the rect
  const xIndexes = Math.floor(xdiff / (subsetRange + 1));
  const yIndexes = Math.floor(ydiff / (subsetRange + 1));

  const xCoords = new Set(
    Array(xIndexes)
      .fill(0)
      .map((_, i) => Math.min(rect.x2 - subsetRange, rect.x1 + subsetRange + i * (subsetRange * 2 + 1)))
  );
  const yCoords = new Set(
    Array(yIndexes)
      .fill(0)
      .map((_, i) => Math.min(rect.y2 - subsetRange, rect.y1 + subsetRange + i * (subsetRange * 2 + 1)))
  );

  const squares = [];
  for (const x of xCoords) {
    for (const y of yCoords) {
      squares.push({ pos: sameRoomPosition(pos, x, y), range: subsetRange });
    }
  }

  return squares;
}

/**
 * Helper for calculating adjacent tiles
 */
export const calculateAdjacencyMatrix = (proximity = 1): { x: number; y: number }[] => {
  let adjacencies = new Array(proximity * 2 + 1).fill(0).map((v, i) => i - proximity);

  return adjacencies
    .flatMap(x => adjacencies.map(y => ({ x, y })))
    .filter((a: { x: number; y: number }) => !(a.x === 0 && a.y === 0));
};

/**
 * Positions in range 1 of `pos` (not includeing `pos`)
 */
export const calculateAdjacentPositions = (pos: RoomPosition) => {
  return calculateNearbyPositions(pos, 1);
};

/**
 * Positions within `proximity` of `pos`, optionally including `pos`
 */
export const calculateNearbyPositions = (pos: RoomPosition, proximity: number, includeCenter = false) => {
  if (proximity === 0) return [pos];
  let adjacent: RoomPosition[] = [];
  adjacent = calculateAdjacencyMatrix(proximity)
    .map(offset => {
      if (pos.x + offset.x < 0 || pos.x + offset.x > 49 || pos.y + offset.y < 0 || pos.y + offset.y > 49) return null;
      return offsetRoomPosition(pos, offset.x, offset.y);
    })
    .filter(roomPos => roomPos !== null) as RoomPosition[];
  if (includeCenter) adjacent.push(pos);
  return adjacent;
};

/**
 * Positions at `proximity` of `pos`
 */
export const calculatePositionsAtRange = (pos: RoomPosition, proximity: number) => {
  const globalPos = globalPosition(pos);
  let positions: RoomPosition[] = [];
  for (let x = globalPos.x - proximity; x <= globalPos.x + proximity; x++) {
    positions.push(fromGlobalPosition({ x, y: globalPos.y - proximity }));
    positions.push(fromGlobalPosition({ x, y: globalPos.y + proximity }));
  }
  for (let y = globalPos.y - proximity + 1; y <= globalPos.y + proximity - 1; y++) {
    positions.push(fromGlobalPosition({ x: globalPos.x - proximity, y }));
    positions.push(fromGlobalPosition({ x: globalPos.x + proximity, y }));
  }
  return positions;
};

/**
 * Adjacent positions that are pathable (optionally ignoring creeps)
 */
export const adjacentWalkablePositions = (pos: RoomPosition, ignoreCreeps = false) =>
  calculateAdjacentPositions(pos).filter(p => isPositionWalkable(p, ignoreCreeps));

/**
 * Check if a position is walkable, accounting for terrain, creeps, and structures
 */
export const isPositionWalkable = (
  pos: RoomPosition,
  ignoreCreeps: boolean = false,
  ignoreStructures: boolean = false
) => {
  let terrain;
  try {
    terrain = Game.map.getRoomTerrain(pos.roomName);
  } catch {
    // Invalid room
    return false;
  }
  if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
    return false;
  }
  if (
    Game.rooms[pos.roomName] &&
    pos.look().some(obj => {
      if (!ignoreCreeps && (obj.type === LOOK_CREEPS || obj.type === LOOK_POWER_CREEPS)) return true;
      if (
        !ignoreStructures &&
        obj.constructionSite &&
        obj.constructionSite.my &&
        (OBSTACLE_OBJECT_TYPES as string[]).includes(obj.constructionSite.structureType)
      )
        return true;
      if (
        !ignoreStructures &&
        obj.structure &&
        ((OBSTACLE_OBJECT_TYPES as string[]).includes(obj.structure.structureType) ||
          (obj.structure instanceof StructureRampart && !obj.structure.my))
      )
        return true;
      return false;
    })
  ) {
    return false;
  }
  return true;
};
