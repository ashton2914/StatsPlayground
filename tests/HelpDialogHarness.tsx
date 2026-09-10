import { useEffect, useState } from "react";

import { HelpDialog } from "../src/components/HelpDialog";
import i18n from "../src/i18n";

export function HelpDialogHarness() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
    let active = true;

    void i18n.changeLanguage("en").then(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      void i18n.changeLanguage(previousLanguage);
    };
  }, []);

  if (!ready) return null;

  return <HelpDialog version="test" onClose={() => {}} />;
}