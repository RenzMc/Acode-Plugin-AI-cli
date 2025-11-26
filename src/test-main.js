import plugin from "../plugin.json";

const sidebarApps = acode.require("sidebarApps");
const selectionMenu = acode.require("selectionMenu");

class TestPlugin {
  async init(baseUrl, $page, { cacheFileUrl, cacheFile }) {
    console.log("Test Plugin Initializing...");
    console.log("baseUrl:", baseUrl);
    console.log("sidebarApps available:", !!sidebarApps);
    console.log("selectionMenu available:", !!selectionMenu);

    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

    // Test 1: Add sidebar icon
    try {
      acode.addIcon("test-icon", this.baseUrl + "icon.png");
      console.log("Icon added successfully");
      
      sidebarApps.add(
        "test-icon",
        "test-sidebar",
        "Test Plugin",
        (container) => {
          container.innerHTML = "<div style='padding: 20px;'><h3>Test Plugin Works!</h3><p>Sidebar is functional.</p></div>";
        },
        false,
        (container) => {
          console.log("Test sidebar selected");
        }
      );
      console.log("Sidebar app added successfully");
    } catch (error) {
      console.error("Sidebar error:", error);
    }

    // Test 2: Add selection menu
    try {
      selectionMenu.add(() => {
        window.toast("Test selection menu works!", 2000);
      }, "🧪", "all");
      console.log("Selection menu added successfully");
    } catch (error) {
      console.error("Selection menu error:", error);
    }
  }

  async destroy() {
    selectionMenu.remove("🧪");
    console.log("Test plugin destroyed");
  }
}

if (window.acode) {
  console.log("Acode available, initializing test plugin...");
  const testPlugin = new TestPlugin();
  acode.setPluginInit(
    plugin.id,
    (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
      testPlugin.init(baseUrl, $page, { cacheFileUrl, cacheFile });
    }
  );
  acode.setPluginUnmount(plugin.id, () => {
    testPlugin.destroy();
  });
}