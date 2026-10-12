import type { BoardDocument, GraphEdge, GraphNode, Part } from "./types";

export interface RowRewrites {
  nodes?: (row: GraphNode) => GraphNode;
  parts?: (row: Part) => Part;
  edges?: (row: GraphEdge) => GraphEdge;
}

export interface SchemaStep {
  to: number;
  ddl?: string[];
  rewrite?: RowRewrites;
}

const FIRST_TABLES = ["boards", "nodes", "edges", "parts", "requests"];

export const SCHEMA_STEPS: SchemaStep[] = [
  {
    to: 1,
    ddl: FIRST_TABLES.map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, data TEXT NOT NULL)`).concat(
      FIRST_TABLES.map((table) => `CREATE INDEX ${table}_board ON ${table}(board_id)`),
    ),
  },
  { to: 2, ddl: ["CREATE TABLE projects (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, data TEXT NOT NULL)"] },
];

export const LATEST_SCHEMA_VERSION = SCHEMA_STEPS[SCHEMA_STEPS.length - 1].to;

export const stepsAbove = (version: number, steps: SchemaStep[] = SCHEMA_STEPS): SchemaStep[] => steps.filter((step) => step.to > version);

export const rewriteDocument = (document: BoardDocument, rewrite: RowRewrites = {}): BoardDocument => ({
  ...document,
  nodes: rewrite.nodes ? document.nodes.map(rewrite.nodes) : document.nodes,
  edges: rewrite.edges ? document.edges.map(rewrite.edges) : document.edges,
  parts: rewrite.parts ? document.parts.map(rewrite.parts) : document.parts,
});

export const migrateDocumentWith = (document: BoardDocument, steps: SchemaStep[] = SCHEMA_STEPS): BoardDocument =>
  stepsAbove(document.version, steps).reduce((current, step) => ({ ...rewriteDocument(current, step.rewrite), version: step.to }), document);
