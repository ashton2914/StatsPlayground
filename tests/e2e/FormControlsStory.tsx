import { useState } from "react";

import {
  Button,
  Checkbox,
  Field,
  NumberField,
  Select,
  TextField,
} from "../../src/components/ui";

export function FormControlsStory() {
  const [name, setName] = useState("");
  const [count, setCount] = useState(2);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState("normal");

  return (
    <div>
      <Field label="Name" hint="Required">
        <TextField value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <NumberField label="Count" value={count} onValueChange={(value) => setCount(value ?? 0)} />
      <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)}>
        Enabled
      </Checkbox>
      <Select label="Mode" value={mode} onChange={(event) => setMode(event.target.value)}>
        <option value="normal">Normal</option>
        <option value="robust">Robust</option>
      </Select>
      <Button disabled={!enabled}>Run {mode} {name} {count}</Button>
    </div>
  );
}
