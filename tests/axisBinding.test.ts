import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import type { YAxisConfig } from "../src/graphCore";
import { prepareAxisBinding } from "../src/components/graphBuilder/axisBinding.ts";

function parseTsx(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function unwrapParens<T extends ts.Node>(node: T): ts.Node {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function containsIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (ts.isIdentifier(n) && n.text === name) found = true;
  });
  return found;
}

function containsNodeText(root: ts.Node, sourceFile: ts.SourceFile, exactText: string): boolean {
  let found = false;
  walk(root, (n) => {
    if (n.getText(sourceFile) === exactText) found = true;
  });
  return found;
}

function isExactSlotFieldBinding(
  prop: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile,
  expectedValue: string,
): boolean {
  if (!ts.isPropertyAssignment(prop) || !ts.isComputedPropertyName(prop.name)) return false;
  const keyExpr = unwrapParens(prop.name.expression);
  if (!ts.isIdentifier(keyExpr) || keyExpr.text !== "slot" || keyExpr.getText(sourceFile) !== "slot") {
    return false;
  }
  const valueExpr = unwrapParens(prop.initializer);
  return ts.isIdentifier(valueExpr)
    && valueExpr.text === expectedValue
    && valueExpr.getText(sourceFile) === expectedValue;
}

const rangeAndStyle: YAxisConfig = {
  min: 2,
  max: 8,
  tickInterval: 1,
  inverse: true,
  showMajorGrid: true,
};

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "category", false, rangeAndStyle),
  {
    bindingChanged: true,
    axisConfig: { inverse: true, showMajorGrid: true },
  },
  "empty -> field should clear range fields and preserve display fields",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, {
    min: 1,
    max: 9,
    tickInterval: 2,
    decimals: 3,
  }),
  {
    bindingChanged: true,
    axisConfig: { decimals: 3 },
  },
  "different field -> field should clear min/max/tickInterval",
);

const unchanged: YAxisConfig = {
  min: 10,
  max: 20,
  tickInterval: 5,
  inverse: true,
};
const unchangedResult = prepareAxisBinding("same", "same", false, unchanged);
assert.strictEqual(unchangedResult.bindingChanged, false, "same field should not count as changed");
assert.strictEqual(unchangedResult.axisConfig, unchanged, "same field should preserve config object identity");

assert.deepStrictEqual(
  prepareAxisBinding("same", "same", true, {
    min: 0,
    max: 100,
    tickInterval: 10,
    showAxisLine: false,
  }),
  {
    bindingChanged: true,
    axisConfig: { showAxisLine: false },
  },
  "hadMulti should force a reset even when the field name is unchanged",
);

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "field", false, undefined),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "undefined config should stay undefined when binding changes",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, { min: 1, max: 2, tickInterval: 0.5 }),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "range-only config should collapse to undefined after reset",
);

const displayOnly: YAxisConfig = {
  decimals: 4,
  inverse: true,
  minorTickCount: 6,
  showAxisLine: false,
  tickPosition: "inside",
  showMajorGrid: true,
  showMinorGrid: false,
  majorGridStyle: { color: "#123456", width: 2, style: "dotted" },
  minorGridStyle: { color: "#abcdef", width: 1, style: "dashed" },
};

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, displayOnly),
  {
    bindingChanged: true,
    axisConfig: displayOnly,
  },
  "all non-range display fields should be preserved verbatim",
);

const graphBuilderSource = readFileSync(
  new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const graphBuilderAst = parseTsx("GraphBuilderView.tsx", graphBuilderSource);

let bindFieldFn: ts.ArrowFunction | ts.FunctionExpression | null = null;
walk(graphBuilderAst, (node) => {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "bindFieldToSlot") {
    return;
  }
  const init = node.initializer;
  if (!init || !ts.isCallExpression(init)) return;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== "useCallback") return;
  const cb = init.arguments[0];
  if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) bindFieldFn = cb;
});

assert.ok(bindFieldFn, "GraphBuilderView.tsx must define bindFieldToSlot via useCallback");
const bindBody = bindFieldFn!.body;
assert.ok(ts.isBlock(bindBody), "bindFieldToSlot callback must have a block body");

let preparedVarName: string | null = null;
let bindingChangedVarName: string | null = null;
let axisConfigVarName: string | null = null;

for (const stmt of bindBody.statements) {
  if (!ts.isVariableStatement(stmt)) continue;
  for (const decl of stmt.declarationList.declarations) {
    if (
      ts.isIdentifier(decl.name)
      && decl.initializer
      && ts.isCallExpression(decl.initializer)
      && ts.isIdentifier(decl.initializer.expression)
      && decl.initializer.expression.text === "prepareAxisBinding"
    ) {
      preparedVarName = decl.name.text;
    }

    if (
      ts.isObjectBindingPattern(decl.name)
      && decl.initializer
      && ts.isIdentifier(decl.initializer)
      && decl.initializer.text === preparedVarName
    ) {
      for (const el of decl.name.elements) {
        const key = el.propertyName ?? el.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(el.name)) continue;
        if (key.text === "bindingChanged") bindingChangedVarName = el.name.text;
        if (key.text === "axisConfig") axisConfigVarName = el.name.text;
      }
    }
  }
}

assert.ok(preparedVarName, "bindFieldToSlot must call prepareAxisBinding before the update gate");
assert.ok(bindingChangedVarName, "bindFieldToSlot must extract bindingChanged from prepareAxisBinding result");
assert.ok(axisConfigVarName, "bindFieldToSlot must extract axisConfig from prepareAxisBinding result");

let guardedAxisIf: ts.IfStatement | null = null;
let guardedPayload: ts.ObjectLiteralExpression | null = null;

function getUpdaterPayload(
  arg: ts.Expression,
): ts.ObjectLiteralExpression | null {
  if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return null;
  const body = unwrapParens(arg.body);
  if (ts.isObjectLiteralExpression(body)) return body;
  if (!ts.isBlock(body)) return null;
  for (const stmt of body.statements) {
    if (!ts.isReturnStatement(stmt) || !stmt.expression) continue;
    const ret = unwrapParens(stmt.expression);
    if (ts.isObjectLiteralExpression(ret)) return ret;
  }
  return null;
}

for (const stmt of bindBody.statements) {
  if (!ts.isIfStatement(stmt) || !ts.isBlock(stmt.thenStatement)) continue;

  for (const thenStmt of stmt.thenStatement.statements) {
    if (!ts.isExpressionStatement(thenStmt) || !ts.isCallExpression(thenStmt.expression)) continue;
    const call = thenStmt.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "setTwoDState") continue;
    if (call.arguments.length < 1) continue;

    const payload = getUpdaterPayload(call.arguments[0]);
    if (!payload) continue;
    const encodingProp = payload.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "encoding",
    );
    if (!encodingProp || !ts.isPropertyAssignment(encodingProp)) continue;
    if (
      !ts.isObjectLiteralExpression(encodingProp.initializer)
      || !encodingProp.initializer.properties.some(
        (prop) => isExactSlotFieldBinding(prop, graphBuilderAst, "field"),
      )
    ) {
      continue;
    }

    let hasAxisXSpread = false;
    let hasAxisYSpread = false;
    let hasMultiXClearSpread = false;
    let hasMultiYClearSpread = false;

    for (const prop of payload.properties) {
      if (!ts.isSpreadAssignment(prop)) continue;
      const spreadExpr = unwrapParens(prop.expression);
      if (!ts.isConditionalExpression(spreadExpr)) continue;

      const cond = spreadExpr.condition;
      const whenTrue = unwrapParens(spreadExpr.whenTrue);
      if (!ts.isObjectLiteralExpression(whenTrue)) continue;

      const axisProp = whenTrue.properties.find((innerProp) =>
        ts.isPropertyAssignment(innerProp)
        && ts.isIdentifier(innerProp.name)
        && ts.isIdentifier(innerProp.initializer)
        && innerProp.initializer.text === axisConfigVarName,
      );
      if (axisProp && ts.isPropertyAssignment(axisProp) && ts.isIdentifier(axisProp.name)) {
        if (
          axisProp.name.text === "xAxis"
          && containsIdentifier(cond, "axisKey")
          && containsNodeText(cond, graphBuilderAst, '"xAxis"')
        ) {
          hasAxisXSpread = true;
        }
        if (
          axisProp.name.text === "yAxis"
          && containsIdentifier(cond, "axisKey")
          && containsNodeText(cond, graphBuilderAst, '"yAxis"')
        ) {
          hasAxisYSpread = true;
        }
      }

      for (const innerProp of whenTrue.properties) {
        if (!ts.isPropertyAssignment(innerProp) || !ts.isIdentifier(innerProp.name)) continue;
        if (
          innerProp.name.text === "multiX"
          && ts.isArrayLiteralExpression(innerProp.initializer)
          && innerProp.initializer.elements.length === 0
          && containsIdentifier(cond, "multiKey")
          && containsNodeText(cond, graphBuilderAst, '"multiX"')
        ) {
          hasMultiXClearSpread = true;
        }
        if (
          innerProp.name.text === "multiY"
          && ts.isArrayLiteralExpression(innerProp.initializer)
          && innerProp.initializer.elements.length === 0
          && containsIdentifier(cond, "multiKey")
          && containsNodeText(cond, graphBuilderAst, '"multiY"')
        ) {
          hasMultiYClearSpread = true;
        }
      }
    }

    if (hasAxisXSpread && hasAxisYSpread && hasMultiXClearSpread && hasMultiYClearSpread) {
      guardedAxisIf = stmt;
      guardedPayload = payload;
      break;
    }
  }

  if (guardedAxisIf) break;
}

assert.ok(guardedAxisIf, "bindFieldToSlot must issue one guarded atomic mode-state update for axis binding");
assert.ok(guardedPayload, "guarded atomic mode-state payload must be present");

assert.ok(
  ts.isBinaryExpression(guardedAxisIf!.expression)
  && guardedAxisIf!.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
  "atomic axis mode-state branch must be guarded by a conjunction",
);

assert.ok(
  containsIdentifier(guardedAxisIf!.expression, bindingChangedVarName!),
  "mode-state guard conjunction must include the binding-change expression derived from prepareAxisBinding",
);

assert.ok(
  containsIdentifier(guardedAxisIf!.expression, "axisKey"),
  "mode-state guard conjunction must include axisKey",
);

let foundSetEncodingFallback = false;
walk(bindBody, (node) => {
  if (!ts.isCallExpression(node)) return;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "setEncoding") return;
  const arg0 = node.arguments[0];
  if (!arg0 || !(ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0))) return;
  const body = arg0.body;
  const candidate = ts.isParenthesizedExpression(body) ? body.expression : body;
  if (!ts.isObjectLiteralExpression(candidate)) return;
  const hasExactSlotField = candidate.properties.some(
    (prop) => isExactSlotFieldBinding(prop, graphBuilderAst, "field"),
  );
  if (hasExactSlotField) foundSetEncodingFallback = true;
});

assert.ok(
  foundSetEncodingFallback,
  "bindFieldToSlot should keep a non-axis fallback that updates encoding without forcing axis/multi resets",
);

console.log("axis binding helper checks passed");
