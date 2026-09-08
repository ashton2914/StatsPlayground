import { inferFieldType, type FieldRef } from "@/graphCore/types";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";

export interface GraphColumnDescriptor {
  columnId: string;
  name: string;
  sqlType: string;
}

type Encoding = Partial<Record<GraphSlotKey, FieldRef>>;

function reconcileField(
  field: FieldRef,
  byId: ReadonlyMap<string, GraphColumnDescriptor>,
  byName: ReadonlyMap<string, GraphColumnDescriptor>,
): FieldRef {
  const descriptor = (field.columnId ? byId.get(field.columnId) : undefined) ?? byName.get(field.name);
  if (!descriptor) return field;
  const type = inferFieldType(descriptor.sqlType);
  if (field.columnId === descriptor.columnId && field.name === descriptor.name && field.type === type) {
    return field;
  }
  return { columnId: descriptor.columnId, name: descriptor.name, type };
}

function reconcileFields(
  fields: FieldRef[],
  byId: ReadonlyMap<string, GraphColumnDescriptor>,
  byName: ReadonlyMap<string, GraphColumnDescriptor>,
): FieldRef[] {
  let changed = false;
  const next = fields.map((field) => {
    const reconciled = reconcileField(field, byId, byName);
    changed ||= reconciled !== field;
    return reconciled;
  });
  return changed ? next : fields;
}

function reconcileEncoding(
  encoding: Encoding,
  byId: ReadonlyMap<string, GraphColumnDescriptor>,
  byName: ReadonlyMap<string, GraphColumnDescriptor>,
): Encoding {
  let changed = false;
  const next: Encoding = {};
  for (const [slot, field] of Object.entries(encoding) as Array<[GraphSlotKey, FieldRef]>) {
    const reconciled = reconcileField(field, byId, byName);
    changed ||= reconciled !== field;
    next[slot] = reconciled;
  }
  return changed ? next : encoding;
}

function migrateLegacyField(
  field: FieldRef,
  oldName: string,
  newName: string,
  sqlType: string,
): FieldRef {
  if (field.name !== oldName) return field;
  return { ...field, name: newName, type: inferFieldType(sqlType) };
}

export function migrateLegacyGraphColumnName(
  item: GraphBuilderItem,
  oldName: string,
  newName: string,
  sqlType: string,
): GraphBuilderItem {
  const migrateFields = (fields: FieldRef[]) => {
    let changed = false;
    const next = fields.map((field) => {
      const migrated = migrateLegacyField(field, oldName, newName, sqlType);
      changed ||= migrated !== field;
      return migrated;
    });
    return changed ? next : fields;
  };
  const migrateEncoding = (encoding: Encoding) => {
    let changed = false;
    const next: Encoding = {};
    for (const [slot, field] of Object.entries(encoding) as Array<[GraphSlotKey, FieldRef]>) {
      const migrated = migrateLegacyField(field, oldName, newName, sqlType);
      changed ||= migrated !== field;
      next[slot] = migrated;
    }
    return changed ? next : encoding;
  };

  const twoDEncoding = migrateEncoding(item.modeStates.twoD.encoding);
  const multiX = migrateFields(item.modeStates.twoD.multiX);
  const multiY = migrateFields(item.modeStates.twoD.multiY);
  const threeDEncoding = migrateEncoding(item.modeStates.threeD.encoding);
  const multivariateColumns = migrateFields(item.modeStates.multivariate.columns);

  let filters = item.filters;
  if (item.filters) {
    let changed = false;
    const next = item.filters.map((filter) => {
      const field = migrateLegacyField(filter.rule.field, oldName, newName, sqlType);
      if (field === filter.rule.field) return filter;
      changed = true;
      return { ...filter, rule: { ...filter.rule, field } };
    });
    if (changed) filters = next;
  }

  const hasLegacyRename = twoDEncoding !== item.modeStates.twoD.encoding
    || multiX !== item.modeStates.twoD.multiX
    || multiY !== item.modeStates.twoD.multiY
    || threeDEncoding !== item.modeStates.threeD.encoding
    || multivariateColumns !== item.modeStates.multivariate.columns
    || filters !== item.filters;
  if (!hasLegacyRename) return item;

  let groupThemeSlots = item.groupThemeSlots;
  if (groupThemeSlots?.[oldName]) {
    const { [oldName]: renamedSlots, ...remainingSlots } = groupThemeSlots;
    groupThemeSlots = { ...remainingSlots, [newName]: renamedSlots };
  }

  return {
    ...item,
    modeStates: {
      twoD: { ...item.modeStates.twoD, encoding: twoDEncoding, multiX, multiY },
      threeD: { ...item.modeStates.threeD, encoding: threeDEncoding },
      multivariate: { ...item.modeStates.multivariate, columns: multivariateColumns },
    },
    filters,
    groupThemeSlots,
  };
}

export function reconcileGraphColumnIdentities(
  item: GraphBuilderItem,
  descriptors: readonly GraphColumnDescriptor[],
): GraphBuilderItem {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.columnId, descriptor]));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const renamedFields = new Map<string, string>();

  const captureRename = (field: FieldRef) => {
    if (!field.columnId) return;
    const descriptor = byId.get(field.columnId);
    if (descriptor && descriptor.name !== field.name) renamedFields.set(field.name, descriptor.name);
  };
  Object.values(item.modeStates.twoD.encoding).forEach(captureRename);
  Object.values(item.modeStates.threeD.encoding).forEach(captureRename);
  item.modeStates.twoD.multiX.forEach(captureRename);
  item.modeStates.twoD.multiY.forEach(captureRename);
  item.modeStates.multivariate.columns.forEach(captureRename);
  item.filters?.forEach((filter) => captureRename(filter.rule.field));

  const twoDEncoding = reconcileEncoding(item.modeStates.twoD.encoding, byId, byName);
  const multiX = reconcileFields(item.modeStates.twoD.multiX, byId, byName);
  const multiY = reconcileFields(item.modeStates.twoD.multiY, byId, byName);
  const threeDEncoding = reconcileEncoding(item.modeStates.threeD.encoding, byId, byName);
  const multivariateColumns = reconcileFields(item.modeStates.multivariate.columns, byId, byName);

  let filters = item.filters;
  if (item.filters) {
    let filtersChanged = false;
    const nextFilters = item.filters.map((filter) => {
      const field = reconcileField(filter.rule.field, byId, byName);
      if (field === filter.rule.field) return filter;
      filtersChanged = true;
      return { ...filter, rule: { ...filter.rule, field } };
    });
    if (filtersChanged) filters = nextFilters;
  }

  let groupThemeSlots = item.groupThemeSlots;
  if (groupThemeSlots && renamedFields.size > 0) {
    let themeChanged = false;
    const nextThemeSlots: NonNullable<GraphBuilderItem["groupThemeSlots"]> = {};
    for (const [fieldName, slots] of Object.entries(groupThemeSlots)) {
      const nextName = renamedFields.get(fieldName) ?? fieldName;
      themeChanged ||= nextName !== fieldName;
      nextThemeSlots[nextName] = slots;
    }
    if (themeChanged) groupThemeSlots = nextThemeSlots;
  }

  const changed = twoDEncoding !== item.modeStates.twoD.encoding
    || multiX !== item.modeStates.twoD.multiX
    || multiY !== item.modeStates.twoD.multiY
    || threeDEncoding !== item.modeStates.threeD.encoding
    || multivariateColumns !== item.modeStates.multivariate.columns
    || filters !== item.filters
    || groupThemeSlots !== item.groupThemeSlots;
  if (!changed) return item;

  return {
    ...item,
    modeStates: {
      twoD: { ...item.modeStates.twoD, encoding: twoDEncoding, multiX, multiY },
      threeD: { ...item.modeStates.threeD, encoding: threeDEncoding },
      multivariate: { ...item.modeStates.multivariate, columns: multivariateColumns },
    },
    filters,
    groupThemeSlots,
  };
}