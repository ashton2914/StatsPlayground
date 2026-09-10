import { useEffect, useState } from "react";

import i18n from "../src/i18n";
import { PostgresDataLinkDialog } from "../src/components/dataLink/PostgresDataLinkDialog";
import { dataLinkService } from "../src/services/dataLinkService";

export function DataLinkHarness() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousTestConnection = dataLinkService.testServerConnection;
    const previousListObjects = dataLinkService.listServerObjects;
    const previousGetSchema = dataLinkService.getServerSchema;
    const previousPreviewObject = dataLinkService.previewServerObject;
    let active = true;

    dataLinkService.testServerConnection = async () => {};
    dataLinkService.listServerObjects = async () => [{
      catalog: "sales",
      schema: "public",
      name: "orders",
      objectType: "table",
    }];
    dataLinkService.getServerSchema = async () => [{
      name: "order_id",
      sourceType: "INTEGER",
      nullable: false,
      primaryKey: true,
      precision: null,
      scale: null,
    }];
    dataLinkService.previewServerObject = async () => ({
      objectName: "orders",
      columns: [{
        name: "order_id",
        sourceType: "INTEGER",
        nullable: false,
        primaryKey: true,
        precision: null,
        scale: null,
      }],
      rows: [[42]],
      truncated: false,
    });

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      dataLinkService.testServerConnection = previousTestConnection;
      dataLinkService.listServerObjects = previousListObjects;
      dataLinkService.getServerSchema = previousGetSchema;
      dataLinkService.previewServerObject = previousPreviewObject;
      void i18n.changeLanguage(previousLanguage);
    };
  }, []);

  if (!ready) return null;

  return (
    <PostgresDataLinkDialog
      existingDatasetNames={[]}
      onClose={() => {}}
      onImported={async () => {}}
    />
  );
}