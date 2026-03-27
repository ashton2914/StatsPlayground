import "./App.css";

function App() {
  return (
    <div className="app">
      {/* Menu Bar */}
      <div className="menu-bar">
        <span>StatsPlayground</span>
        <button>文件</button>
        <button>编辑</button>
        <button>分析</button>
        <button>图表</button>
        <button>工具</button>
        <button>帮助</button>
      </div>

      {/* Workspace */}
      <div className="workspace">
        {/* Left: Data Source Panel */}
        <div className="side-panel">
          <h3>数据源</h3>
          <div className="empty-hint">导入数据以开始分析</div>
        </div>

        {/* Center: Main Content */}
        <div className="main-area">
          <div className="main-content">
            <div className="welcome">
              <h1>StatsPlayground</h1>
              <p>轻量级 · 跨平台 · 开源</p>
              <p>数据分析工具</p>
              <div className="version">v0.1.0</div>
            </div>
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <span>就绪</span>
      </div>
    </div>
  );
}

export default App;
