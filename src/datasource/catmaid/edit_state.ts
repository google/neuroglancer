import type {
  CatmaidEditContext,
  CatmaidEditNodeContext,
  CatmaidEditParentContext,
} from "#src/datasource/catmaid/api.js";
import { getCatmaidRevisionToken } from "#src/datasource/catmaid/api.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
  getSpatiallyIndexedSkeletonPathToRoot,
} from "#src/skeleton/node_traversal.js";

function requireRevisionToken(
  node: SpatiallyIndexedSkeletonNode,
  role: string,
): string {
  const revisionToken = getCatmaidRevisionToken(node.sourceState);
  if (revisionToken === undefined) {
    throw new Error(
      `Inspected CATMAID ${role} node ${node.nodeId} is missing revision metadata.`,
    );
  }
  return revisionToken;
}

export function toCatmaidEditNodeContext(
  node: SpatiallyIndexedSkeletonNode,
): CatmaidEditNodeContext {
  return {
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId,
    revisionToken: requireRevisionToken(node, "target"),
  };
}

export function toCatmaidEditParentContext(
  node: SpatiallyIndexedSkeletonNode,
): CatmaidEditParentContext {
  return {
    nodeId: node.nodeId,
    revisionToken: requireRevisionToken(node, "related"),
  };
}

export function buildCatmaidNodeEditContext(
  node: SpatiallyIndexedSkeletonNode,
): CatmaidEditContext {
  return {
    node: toCatmaidEditNodeContext(node),
  };
}

export function buildCatmaidNeighborhoodEditContext(
  node: SpatiallyIndexedSkeletonNode,
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
): CatmaidEditContext {
  const parentNode = getSpatiallyIndexedSkeletonNodeParent(segmentNodes, node);
  const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
    segmentNodes,
    node.nodeId,
  );
  return {
    node: toCatmaidEditNodeContext(node),
    ...(parentNode === undefined
      ? {}
      : { parent: toCatmaidEditParentContext(parentNode) }),
    children: childNodes.map(toCatmaidEditParentContext),
  };
}

export function buildCatmaidRerootEditContext(
  node: SpatiallyIndexedSkeletonNode,
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
): CatmaidEditContext {
  return {
    ...buildCatmaidNeighborhoodEditContext(node, segmentNodes),
    nodes: getSpatiallyIndexedSkeletonPathToRoot(segmentNodes, node).map(
      toCatmaidEditParentContext,
    ),
  };
}

export function buildCatmaidInsertEditContext(
  parentNode: SpatiallyIndexedSkeletonNode,
  childNodes: readonly SpatiallyIndexedSkeletonNode[],
): CatmaidEditContext {
  return {
    node: buildCatmaidNodeEditContext(parentNode).node,
    children: childNodes.map(toCatmaidEditParentContext),
  };
}

export function buildCatmaidMultiNodeEditContext(
  ...nodes: SpatiallyIndexedSkeletonNode[]
): CatmaidEditContext {
  return {
    nodes: nodes.map(toCatmaidEditParentContext),
  };
}
