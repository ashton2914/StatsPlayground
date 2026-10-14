import { useEffect, useState } from "react";

import i18n from "../src/i18n";
import { PostgresDataLinkDialog } from "../src/components/dataLink/PostgresDataLinkDialog";
import { dataLinkService } from "../src/services/dataLinkService";

export function DataLinkHarness({ language = "en" }: { language?: string }) {
  const [ready, setReady] = useState(false);
  const [connectionCalls, setConnectionCalls] = useState(0);

  useEffect(() => {
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    const previousTestConnection = dataLinkService.testServerConnection;
    const previousListObjects = dataLinkService.listServerObjects;
    const previousGetSchema = dataLinkService.getServerSchema;
    const previousPreviewObject = dataLinkService.previewServerObject;
    let active = true;

    dataLinkService.testServerConnection = async () => { setConnectionCalls((count) => count + 1); };
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

    void i18n.changeLanguage(language).then(() => {
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
  }, [language]);

  if (!ready) return null;

  return (
    <>
    <output aria-label="Connection test calls">{connectionCalls}</output>
    <PostgresDataLinkDialog
      existingDatasetNames={[]}
      onClose={() => {}}
      onImported={async () => {}}
    />
    </>
  );
}
