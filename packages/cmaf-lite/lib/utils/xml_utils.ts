import { decodeIso8601Duration } from "@svta/cml-iso-8601";
import * as txml from "txml";
import * as asserts from "./asserts";

/**
 * Parse an XML document and return the first element matching
 * the given tagName. Throws when no such element is found.
 */
export function parseXml(text: string, tagName: string): txml.TNode {
  const nodes = txml.parse(text);
  const root = nodes.find(
    (n): n is txml.TNode => txml.isElementNode(n) && n.tagName === tagName,
  );
  asserts.assertExists(root, `No ${tagName} element found in document`);
  return root;
}

export type AttrParser<T> = (raw: string) => T;

export function attr<T>(
  node: txml.TNode,
  name: string,
  parser: AttrParser<T>,
): T | undefined;
export function attr<T>(
  node: txml.TNode,
  name: string,
  parser: AttrParser<T>,
  defaultValue: T,
): T;
export function attr<T>(
  node: txml.TNode,
  name: string,
  parser: AttrParser<T>,
  defaultValue?: T,
): T | undefined {
  const raw = node.attributes[name];
  if (raw != null) {
    return parser(raw);
  }
  return defaultValue;
}

export function attrRequired<T>(
  node: txml.TNode,
  name: string,
  parser: AttrParser<T>,
): T {
  const raw = node.attributes[name];
  asserts.assertExists(
    raw,
    `Required attribute "${name}" missing on <${node.tagName}>`,
  );
  return parser(raw);
}

/**
 * Return the first child element with the given tagName, or undefined.
 */
export function child(
  node: txml.TNode,
  tagName: string,
): txml.TNode | undefined {
  for (const c of node.children) {
    if (txml.isElementNode(c) && c.tagName === tagName) {
      return c;
    }
  }
  return undefined;
}

/**
 * Return all child elements with the given tagName.
 */
export function children(node: txml.TNode, tagName: string): txml.TNode[] {
  const result: txml.TNode[] = [];
  for (const c of node.children) {
    if (txml.isElementNode(c) && c.tagName === tagName) {
      result.push(c);
    }
  }
  return result;
}

/**
 * Concatenate the direct text children of a node. Returns undefined
 * when the node is undefined or has no text content.
 */
export function text(node: txml.TNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  let result = "";
  for (const c of node.children) {
    if (!txml.isElementNode(c)) {
      result += c;
    }
  }
  return result.length > 0 ? result : undefined;
}

export function parseString(raw: string): string {
  return raw;
}

export function parseNumber(raw: string): number {
  const n = Number(raw);
  asserts.assertNumber(n, `Expected a number, got "${raw}"`);
  return n;
}

export function parseDuration(raw: string): number {
  return decodeIso8601Duration(raw);
}

export function parseDate(raw: string): Date {
  const date = new Date(raw);
  asserts.assertNumber(date.getTime(), `Expected a date, got "${raw}"`);
  return date;
}
