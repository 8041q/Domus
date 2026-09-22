export type Vec2 = { x: number; z: number };

export type AppMode = 'build' | 'furnish';
export type BuildWorkspaceView = 'plan' | '3d';
export type FurnishCameraView = 'perspective' | 'top' | 'front' | 'back' | 'left' | 'right';
export type MeasurementSystem = 'metric' | 'imperial';
export type RoomWall = 'north' | 'east' | 'south' | 'west';
export type OpeningType = 'door' | 'window' | 'opening';
export type OpeningVariant =
  | 'single-window'
  | 'double-window'
  | 'full-height-window'
  | 'high-window'
  | 'sliding-window'
  | 'single-door'
  | 'double-door'
  | 'door-frame'
  | 'glass-door'
  | 'glass-double-door'
  | 'wall-opening';
export type FloorFinish = 'light-oak' | 'warm-oak' | 'stone' | 'concrete';
export type RoomShapeKind = 'rectangle' | 'l-shape' | 'recess' | 'custom';

export interface RoomVertex extends Vec2 {
  id: string;
}

export interface RoomState {
  /** Bounding width in metres. Kept in sync with vertices. */
  width: number;
  /** Bounding depth in metres. Kept in sync with vertices. */
  depth: number;
  height: number;
  wallColor: string;
  floorFinish: FloorFinish;
  shapeKind: RoomShapeKind;
  /** Ordered simple room perimeter. Walls may be orthogonal or angled. */
  vertices: RoomVertex[];
}

export interface RoomOpening {
  id: string;
  type: OpeningType;
  /** Stable wall segment id derived from its endpoint vertex ids. */
  wallId: string;
  /** Distance in metres from the wall segment's start vertex to the opening centre. */
  offset: number;
  width: number;
  height: number;
  sillHeight: number;
  /** Architectural subtype used by the 2D/3D opening editor. */
  variant: OpeningVariant;
}

export interface RoomWallSegment {
  id: string;
  index: number;
  start: RoomVertex;
  end: RoomVertex;
  length: number;
  horizontal: boolean;
  /** Unit vector following the wall from start to end. */
  tangent: Vec2;
  /** Unit vector pointing into the room. */
  inward: Vec2;
}

export type ProductKind =
  | 'sofa'
  | 'armchair'
  | 'dining-table'
  | 'coffee-table'
  | 'chair'
  | 'cabinet'
  | 'bookcase'
  | 'rug'
  | 'plant';

export type ProductCategory = 'Seating' | 'Tables' | 'Storage' | 'Decor';

export interface ClearanceRule {
  front: number;
  back: number;
  sides: number;
}

export interface ProductDefinition {
  id: ProductKind;
  name: string;
  category: ProductCategory;
  width: number;
  depth: number;
  height: number;
  wallAffinity?: boolean;
  collision?: boolean;
  clearance: ClearanceRule;
  priceLabel: string;
  swatch: string;
}

export interface PlacedObject {
  id: string;
  productId: ProductKind;
  x: number;
  z: number;
  rotationY: number;
}

export interface PlannerSnapshot {
  room: RoomState;
  openings: RoomOpening[];
  objects: PlacedObject[];
}

export interface SnapAxisFeedback {
  kind: 'wall' | 'object' | 'center';
  axis: 'x' | 'z';
  value: number;
  targetId?: string;
  label: string;
}

export interface SnapFeedback {
  kind: 'none' | 'wall' | 'object' | 'center' | 'multi';
  x?: SnapAxisFeedback;
  z?: SnapAxisFeedback;
  label?: string;
}

export interface PlacementResult {
  x: number;
  z: number;
  rotationY?: number;
  colliding: boolean;
  pushedByCollision: boolean;
  snap: SnapFeedback;
}

export interface ClearanceIssue {
  type: 'room' | 'object';
  message: string;
  targetId?: string;
}
