import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import "./index.css";
import "./i18n";
import "./stores/useThemeStore";

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (import.meta.env.DEV && import.meta.env.VITE_SCATTER_BENCHMARK === "1") {
  import("./benchmarks/ScatterBudgetBenchmark").then(({ ScatterBudgetBenchmark }) => {
    root.render(<ScatterBudgetBenchmark />);
  });
} else if (import.meta.env.DEV && import.meta.env.VITE_TIME_SERIES_BENCHMARK === "1") {
  import("./benchmarks/TimeSeriesBenchmark").then(({ TimeSeriesBenchmark }) => {
    root.render(<TimeSeriesBenchmark />);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
