class GroupList {
  constructor() {
    this.groups = [];
    this._tabCache = new Map();
    this._activeTab = null;
    this._container = document.getElementById("container");
    this.windowId = null;
    this._contextMenu = null;
    this._signalBatchMove = false;
    this._resetDragContext();
    this._reverseTabDisplay = false;

    this._searchBar = document.getElementById("search");
    this._cancelButton = document.getElementById("cancel-search-icon");
    this._groupBaton = null;

    document
      .getElementById("new-group-button")
      .addEventListener("click", () => {
        browser.runtime.sendMessage({
          method: "createGroup",
          windowId: this.windowId
        });
      });

    document.getElementById("settings-button").addEventListener("click", () => {
      browser.runtime.openOptionsPage();
    });

    this._searchBar.addEventListener("focus", () => {
      this._searchBar.parentNode.style.border = `1px solid var(--search-border-focus)`;
    });

    this._searchBar.addEventListener("blur", () => {
      this._searchBar.parentNode.style.border = "";
    });

    this._searchBar.addEventListener("keyup", e => {
      if (e.key === "Escape" || e.key === "Esc") {
        this._searchBar.value = "";
        this._cancelButton.classList.add("hidden");
        this._searchBar.blur();
        this.displayAll();
        return;
      }

      this._cancelButton.classList.toggle("hidden", !this._searchBar.value);
      this._searchBar.value
        ? this.filterFromText(this._searchBar.value)
        : this.displayAll();
    });

    this._cancelButton.addEventListener("click", () => {
      this._cancelButton.classList.add("hidden");
      this._searchBar.value = "";
      this.displayAll();
    });

    // event registration for tab syncing
    browser.tabs.onActivated.addListener(info => this.onActivated(info));
    browser.tabs.onRemoved.addListener((tabId, info) =>
      this.onRemoved(tabId, info)
    );
    browser.tabs.onDetached.addListener((tabId, info) =>
      this.onDetached(tabId, info)
    );
    browser.tabs.onAttached.addListener((tabId, info) =>
      this.onAttached(tabId, info)
    );
    browser.tabs.onUpdated.addListener((tabId, changeInfo, info) =>
      this.onUpdated(tabId, changeInfo, info)
    );
    browser.tabs.onMoved.addListener((tabId, moveInfo) =>
      this.onMoved(tabId, moveInfo)
    );

    // event registration for changes in group settings
    browser.storage.onChanged.addListener((changes, area) =>
      this.onStorageChange(changes, area)
    );

    this._container.addEventListener("dragover", e => this.onDragOver(e));
    this._container.addEventListener("dragstart", e => this.onDragStart(e));
    this._container.addEventListener("dragend", e => this.onDragEnd(e));
    this._container.addEventListener("drop", e => this.onDrop(e));
    this._container.addEventListener("contextmenu", e => this.onContextMenu(e));

    window.addEventListener("click", e => {
      this.hideContextMenu();
      this.maybeCleanSelection(e);
    });
    window.addEventListener("blur", e => {
      this.hideContextMenu();
      this.maybeCleanSelection(e);
    });
    window.addEventListener("keyup", e => {
      if (e.key === "Escape") {
        this.hideContextMenu();
        this.maybeCleanSelection(e);
      }
    });
  }

  _resetDragContext() {
    this._dragContext = {
      group: null,
      isSoloTab: false,
      tab: null
    };
  }

  setGroupBaton(groupId) {
    this._groupBaton = this.getGroup(groupId);
  }

  notifyGroupChange(tabs, groupId) {
    let activeIndex = tabs.findIndex(t => t.active);
    this.port.postMessage({
      method: "syncTabs",
      tabIds: tabs.map(t => t.id),
      active: activeIndex !== -1,
      activeTabId: activeIndex !== -1 ? tabs[activeIndex].id : null,
      groupId: groupId,
      windowId: this.windowId
    });
  }

  async getWindowId() {
    let windowInfo = await browser.windows.getCurrent({
      windowTypes: ["normal"]
    });
    this.windowId = windowInfo.id;
    return windowInfo.id;
  }

  populateFrom(groupInfo, tabs) {
    let group = new Group(groupInfo);
    for (let tab of tabs) {
      if (tab.windowId !== this.windowId) {
        continue;
      }

      let entry = new TabEntry(tab);
      if (tab.active) {
        this._activeTab = entry;
      }

      this._tabCache.set(tab.id, entry);
      group.addTab(entry);
    }

    this.addGroup(group);
    group.toggleReverseDisplay(this._reverseTabDisplay);
    group.sortByPosition();

    if (this._activeTab) {
      this.setActive(this._activeTab);
      this._activeTab.scrollTo();
    }
  }

  async populate() {
    let tabs = await browser.tabs.query({ windowId: this.windowId });

    let old = await browser.storage.local.get([
      "groups",
      "reverseTabDisplay",
      "darkTheme"
    ]);
    this._reverseTabDisplay = old.reverseTabDisplay;
    let isDarkTheme = old.hasOwnProperty("darkTheme") && old.darkTheme === true;
    document.body.classList.add(isDarkTheme ? "dark-theme" : "light-theme");

    if (!old.hasOwnProperty("groups")) {
      this.port.postMessage({
        method: "freshInstall",
        windowId: this.windowId,
        tabs: tabs
      });
    } else {
      // load our groups from localStorage
      await this.loadFromLocalStorage(old.groups, tabs);
    }
  }

  async loadFromLocalStorage(groups, tabs) {
    // fast lookup
    let lookup = new Map();

    for (let data of groups) {
      let group = new Group(data);
      group.parent = this;
      this.groups.push(group);
      lookup.set(group.uuid, group);
    }

    let oldActiveGroup = this.groups.find(g => g.active) || this.groups[0];
    let deadEntries = [];

    for (let tab of tabs) {
      let entry = new TabEntry(tab);
      if (tab.active) {
        this._activeTab = entry;
      }

      this._tabCache.set(tab.id, entry);

      // get the group associated with the tab
      let groupId = await browser.sessions.getTabValue(tab.id, "group-id");
      if (groupId) {
        let group = lookup.get(groupId, null);
        if (group) {
          group.loadTab(entry);
        } else {
          console.log(`group ${groupId} is not found`);
        }
      } else {
        // a tab with no group ID in its session is a "ghost" tab
        // which means we have to assign it to the last active group
        if (oldActiveGroup) {
          oldActiveGroup.addTab(entry);
          deadEntries.push(entry);
        }
      }
    }

    // sort the groups and add to the container
    for (let group of this.groups) {
      group.sortByPosition();
      group.toggleReverseDisplay(this._reverseTabDisplay);
      this._container.appendChild(group.view);
    }

    if (deadEntries.length > 0 && oldActiveGroup) {
      this.notifyGroupChange(deadEntries, oldActiveGroup.uuid);
    }

    if (this._activeTab) {
      this.setActive(this._activeTab);
      this._activeTab.scrollTo();
    }
  }

  resyncFromGroupData(groups) {
    this.groups = [];
    while (this._container.lastChild) {
      this._container.removeChild(this._container.lastChild);
    }

    let lookup = new Map();
    for (let data of groups) {
      let group = new Group(data);
      group.parent = this;
      this.groups.push(group);
      this._container.appendChild(group.view);
      lookup.set(group.uuid, group);
    }

    let deadTabs = [];
    for (let tab of this._tabCache.values()) {
      if (!tab.group) {
        // not sure what happened here?
        continue;
      }

      let group = lookup.get(tab.group.uuid);
      if (group) {
        group.addTab(tab);
      } else {
        deadTabs.push(tab);
      }
    }
    deadTabs.forEach(t => t.close());
    this.groups.forEach(g => g.sortByPosition());
  }

  async resync() {
    let tabs = await browser.tabs.query({ windowId: this.windowId });
    for (var tab of tabs) {
      let entry = this.getTab(tab.id);
      entry.update(tab);
    }
  }

  clearSelectedExcept(group) {
    let uuid = group && group.uuid;
    for (let g of this.groups) {
      if (g.uuid !== uuid) {
        g.clearSelected();
      }
    }
  }

  maybeCleanSelection(e) {
    // clean the selection if we're clicking outside of a group boundary
    let group = e.target === window ? null : Group.groupIdFromEvent(e);
    if (group === null) {
      this.groups.forEach(g => g.cleanSelected());
    }
  }

  addGroup(group) {
    group.parent = this;
    this.groups.push(group);
    this._container.appendChild(group.view);
    this.saveStorage();
  }

  // meant to be used internally inside onStorageChange
  addGroupAt(index, group) {
    group.parent = this;
    this.groups.splice(index, 0, group);
    let beforeNode = this.groups[index].view;
    this._container.insertBefore(group.view, beforeNode);
  }

  displayAll() {
    for (let tab of this._tabCache.values()) {
      tab.show();
    }
  }

  getTab(tabId) {
    return this._tabCache.get(tabId, null);
  }

  getGroup(groupId) {
    let group = this.groups.find(g => g.uuid == groupId);
    if (group === undefined) {
      return null;
    }
    return group;
  }

  removeGroup(group) {
    let index = this.groups.indexOf(group);
    if (index == -1) {
      // kind of strange
      return;
    }

    for (let tab of group.tabs) {
      tab.close();
    }

    this._container.removeChild(group.view);
    this.groups.splice(index, 1);
    this.saveStorage();
  }

  /*
    This is meant to be used internally to sync with localStorage.
  */
  removeGroupByIndex(index) {
    let group = this.groups[index];
    for (let tab of group.tabs) {
      tab.close();
    }

    this._container.removeChild(group.view);
    this.groups.splice(index, 1);
  }

  get activeGroup() {
    return this._activeTab && this._activeTab.group;
  }

  get groupCount() {
    return this.groups.length;
  }

  filterFromText(query) {
    for (let tab of this._tabCache.values()) {
      let match = tab.shouldHide(query);
      tab.toggleVisibility(match);
    }
  }

  createTab(opts) {
    this._groupBaton = opts.group || this.activeGroup;
    browser.tabs.create({ active: opts.active || true });
  }

  beginBatchMove() {
    this._signalBatchMove = true;
  }

  endBatchMove() {
    this._signalBatchMove = false;
  }

  toJSON() {
    return {
      groups: this.groups.map(group => group.toJSON())
    };
  }

  saveStorage() {
    browser.storage.local.set(this.toJSON());
  }

  hideContextMenu() {
    if (this._contextMenu) {
      this._contextMenu.hide();
      this._contextMenu = null;
    }
  }

  onContextMenu(e) {
    this.hideContextMenu();
    e.preventDefault();

    let tabId = TabEntry.tabIdFromEvent(e);
    let items = [];
    if (tabId !== null) {
      let tab = this.getTab(tabId);
      if (!tab) {
        return;
      }

      let group = tab.group;
      if (group.isSelected(tab) && group.selectedCount >= 2) {
        items = group.getSelectedContextMenuItems(this);
      } else {
        items = tab.getContextMenuItems(this);
      }
    } else {
      let groupId = Group.groupIdFromEvent(e);
      if (groupId === null) {
        return;
      }
      let group = this.getGroup(groupId);
      if (!group) {
        return;
      }
      items = group.getContextMenuItems(this);
    }

    this._contextMenu = new ContextMenu(e, items);
    this._contextMenu.show();
  }

  onActivated(info) {
    console.log(
      `onActivated: ${this.windowId}/${info.tabId} -> ${JSON.stringify(info)}`
    );
    if (info.windowId !== this.windowId) {
      return;
    }

    this.setActive(this.getTab(info.tabId), true);
  }

  onMoved(tabId, moveInfo) {
    console.log(`${this.windowId}/${tabId} -> ${JSON.stringify(moveInfo)}`);
    if (moveInfo.windowId !== this.windowId || this._signalBatchMove) {
      return;
    }

    let tab = this.getTab(tabId);
    if (!tab || !tab.group) {
      return;
    }

    /*
      - Swap positions
      - Increment index for toIndex to fromIndex-1 if fromIndex > toIndex
        - If toIndex > fromIndex then subtract index by 1 instead
    */

    tab.group.repositionTab(tabId, moveInfo.toIndex);
    let min, max, increment;
    if (moveInfo.toIndex > moveInfo.fromIndex) {
      increment = -1;
      min = moveInfo.fromIndex;
      max = moveInfo.toIndex + 1;
    } else {
      increment = 1;
      min = moveInfo.toIndex;
      max = moveInfo.fromIndex;
    }

    for (var entry of this._tabCache.values()) {
      if (entry.index >= min && entry.index < max) {
        entry.index += increment;
      }
    }

    tab.index = moveInfo.toIndex;
  }

  setActive(tab, save = false) {
    if (this._activeTab) {
      this._activeTab.toggleActive(false);
    }

    if (tab) {
      let groupId = null;
      tab.toggleActive(true);
      if (tab.group !== this._activeTab.group) {
        this.clearSelectedExcept(tab.group);
        if (save) {
          this.saveStorage();
        }
        if (tab.group) {
          groupId = tab.group.uuid;
        }
      } else {
        groupId = this._activeTab.group && this._activeTab.group.uuid;
      }
      this._activeTab = tab;
      if (groupId) {
        this.port.postMessage({
          method: "activeSync",
          windowId: this.windowId,
          groupId: groupId,
          tabId: tab.id
        });
      }
    }
  }

  scrollToActiveTab() {
    if (this._activeTab) {
      this._activeTab.scrollTo();
    }
  }

  onCreated(tabInfo) {
    console.log(`onCreated: ${this.windowId}/${tabInfo.id}`);
    if (tabInfo.windowId !== this.windowId) {
      return;
    }

    // update the positions of the tabs
    for (var tab of this._tabCache.values()) {
      if (tab.index >= tabInfo.index) {
        tab.index += 1;
      }
    }

    let entry = new TabEntry(tabInfo);
    this._tabCache.set(tabInfo.id, entry);

    if (this._searchBar.value) {
      entry.toggleVisibility(entry.shouldHide(this._searchBar.value));
    }

    browser.sessions.getTabValue(entry.id, "group-id").then(groupId => {
      let group = this._groupBaton ? this._groupBaton : this.getGroup(groupId);
      if (group) {
        let relativeTab = tabInfo.hasOwnProperty("openerTabId")
          ? this.getTab(tabInfo.openerTabId)
          : group.getRightBefore(entry.index);
        group.addTab(entry, relativeTab);
        if (entry.active) {
          this.setActive(entry, true);
        }
      }
      this._groupBaton = null;
    });
  }

  _removeTab(tabId) {
    let tab = this.getTab(tabId);
    if (tab) {
      tab.detach();
    }
    this._tabCache.delete(tabId);

    // update positions
    if (tab) {
      for (var entry of this._tabCache.values()) {
        if (entry.index >= tab.index) {
          entry.index -= 1;
        }
      }
    }
  }

  onRemoved(tabId, removeInfo) {
    console.log(`onRemoved: ${this.windowId}/${tabId}`);
    this._removeTab(tabId);
  }

  onDetached(tabId, detachInfo) {
    console.log(
      `onDetached: ${this.windowId}/${tabId} -> ${JSON.stringify(detachInfo)}`
    );
    this._removeTab(tabId);
  }

  async onAttached(tabId, attachInfo) {
    console.log(
      `onAttached: ${this.windowId}/${tabId} -> ${JSON.stringify(attachInfo)}`
    );
    if (attachInfo.newWindowId !== this.windowId) {
      return;
    }

    let tabInfo = await browser.tabs.get(tabId);
    tabInfo.id = tabId;
    let entry = new TabEntry(tabInfo);
    this._tabCache.set(tabInfo.id, entry);
    let group = this.activeGroup;

    if (group) {
      group.attachTab(entry, attachInfo.newPosition);
    }

    if (entry.active) {
      this.setActive(entry);
    }
  }

  onUpdated(tabId, changeInfo, tabInfo) {
    console.log(
      `onUpdated: ${this.windowId}/${tabId} -> ${JSON.stringify(
        changeInfo
      )} -> ${JSON.stringify(tabInfo)}`
    );
    let tab = this.getTab(tabId);
    if (tab) {
      tab.update(changeInfo);
      if (this._searchBar.value) {
        tab.toggleVisibility(tab.shouldHide(this._searchBar.value));
      }
    }
  }

  /* drag and drop events */

  onDragOver(e) {
    // only groups and tabs are draggable
    if (TabEntry.tabIdFromEvent(e) || Group.groupIdFromEvent(e)) {
      e.preventDefault();
    }
  }

  onDragStart(e) {
    e.dataTransfer.dropEffect = "move";
    e.dataTransfer.setData("text/plain", "...");

    let tabId = TabEntry.tabIdFromEvent(e);
    if (tabId) {
      let tab = (this._dragContext.tab = this.getTab(tabId));
      if (tab) {
        this._dragContext.group = tab.group;
        let isSolo = (this._dragContext.isSoloTab =
          tab.group.selectedCount <= 1);
        if (isSolo) {
          tab.view.classList.add("drag-target");
        } else {
          this._dragContext.group.styleSelectedDragStart(true);
        }
      }
    } else {
      let groupId = Group.groupIdFromEvent(e);
      let g = (this._dragContext.group = this.getGroup(groupId));
      g.view.classList.add("drag-target");
    }
  }

  onDragEnd(e) {
    if (this._dragContext.tab !== null) {
      if (this._dragContext.isSoloTab) {
        this._dragContext.tab.view.classList.remove("drag-target");
      } else {
        this._dragContext.group.styleSelectedDragStart(false);
      }
    } else if (this._dragContext.group !== null) {
      this._dragContext.group.view.classList.remove("drag-target");
    }
  }

  async _dropTabs(e, groupIndex) {
    e.preventDefault();

    let relativeTab = this.getTab(TabEntry.tabIdFromEvent(e));
    let group = this.groups[groupIndex];

    if (this._dragContext.isSoloTab) {
      if (relativeTab === this._dragContext.tab) {
        return;
      }

      this._dragContext.group.removeTab(this._dragContext.tab);
      await group.appendTabs([this._dragContext.tab], relativeTab);
      await this.port.postMessage({
        method: "syncTabs",
        tabIds: [this._dragContext.tab.id],
        active: this._dragContext.tab.active,
        activeTabId: this._dragContext.tab.active
          ? this._dragContext.tab.id
          : null,
        groupId: group.uuid,
        windowId: this.windowId
      });
    } else {
      this._dragContext.group.styleSelectedDragStart(false);
      let tabs = this._dragContext.group.popSelected();
      let activeIndex = tabs.findIndex(t => t.active);
      await group.appendTabs(tabs, relativeTab);
      await this.port.postMessage({
        method: "syncTabs",
        tabIds: tabs.map(t => t.id),
        active: activeIndex !== -1,
        activeTabId: activeIndex !== -1 ? tabs[activeIndex].id : null,
        groupId: group.uuid,
        windowId: this.windowId
      });
    }
  }

  async onDrop(e) {
    console.log("Drop", e, this._dragContext);
    let groupId = Group.groupIdFromEvent(e);
    if (!groupId) {
      return;
    }

    let groupIndex = this.groups.findIndex(g => g.uuid == groupId);
    if (groupIndex === -1) {
      return;
    }

    if (this._dragContext.tab !== null) {
      // we're drag and dropping tabs into a group
      await this._dropTabs(e, groupIndex);
    } else if (this._dragContext.group !== null) {
      // we're drag and dropping a group
      let group = this.groups[groupIndex];
      if (group === this._dragContext.group) {
        return;
      }

      let originalIndex = this.groups.indexOf(this._dragContext.group);

      // remove the group and reinsert it at the appropriate position
      this.groups.splice(
        groupIndex,
        0,
        this.groups.splice(originalIndex, 1)[0]
      );

      // modify the DOM to point to the new structure
      if (originalIndex > groupIndex) {
        this._container.insertBefore(this._dragContext.group.view, group.view);
      } else {
        this._container.insertBefore(
          this._dragContext.group.view,
          group.view.nextSibling
        );
      }
      e.preventDefault();
      this.saveStorage();
    }

    this._resetDragContext();
  }

  onStorageChange(changes, area) {
    if (area !== "local") {
      return;
    }

    if (changes.hasOwnProperty("reverseTabDisplay")) {
      this._reverseTabDisplay = changes.reverseTabDisplay.newValue;
      for (let group of this.groups) {
        group.toggleReverseDisplay(this._reverseTabDisplay);
      }
    }

    if (changes.hasOwnProperty("darkTheme")) {
      let newValue = changes.darkTheme.newValue;
      if (newValue) {
        document.body.classList.remove("light-theme");
        document.body.classList.add("dark-theme");
      } else {
        document.body.classList.remove("dark-theme");
        document.body.classList.add("light-theme");
      }
    }

    if (changes.hasOwnProperty("groups")) {
      this.resyncFromGroupData(changes.groups.newValue);
    }
  }
}

// for debugging purposes
var groupList;
var port;

function onMessage(message) {
  if (message.method == "onTabCreated") {
    groupList.onCreated(message.data);
  } else if (message.method == "moveTabGroup") {
    let tab = groupList.getTab(message.tabId);
    let group = groupList.getGroup(message.groupId);
    if (tab && group) {
      tab.detach();
      group.loadTab(tab);
      group.repositionTab(tab.id, tab.index);
    }
  } else if (
    message.method == "setGroupBaton" &&
    message.windowId === groupList.windowId
  ) {
    groupList.setGroupBaton(message.groupId);
  } else if (message.method == "finishedFreshInstall") {
    groupList.populateFrom(message.group, message.tabs);
  }
}

(async () => {
  groupList = new GroupList();
  let windowId = await groupList.getWindowId();

  port = browser.runtime.connect({ name: windowId.toString() });
  groupList.port = port;
  port.onMessage.addListener(onMessage);

  await groupList.populate();

  window.addEventListener("unload", e => {
    port.disconnect();
  });
})();
