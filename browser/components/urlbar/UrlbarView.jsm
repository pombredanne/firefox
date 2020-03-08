/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = ["UrlbarView"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  UrlbarPrefs: "resource:///modules/UrlbarPrefs.jsm",
  UrlbarTokenizer: "resource:///modules/UrlbarTokenizer.jsm",
  UrlbarUtils: "resource:///modules/UrlbarUtils.jsm",
});

// Stale rows are removed on a timer with this timeout.  Tests can override this
// by setting UrlbarView.removeStaleRowsTimeout.
const DEFAULT_REMOVE_STALE_ROWS_TIMEOUT = 400;

const getBoundsWithoutFlushing = element =>
  element.ownerGlobal.windowUtils.getBoundsWithoutFlushing(element);

/**
 * Receives and displays address bar autocomplete results.
 */
class UrlbarView {
  /**
   * @param {UrlbarInput} input
   *   The UrlbarInput instance belonging to this UrlbarView instance.
   */
  constructor(input) {
    this.input = input;
    this.panel = input.panel;
    this.controller = input.controller;
    this.document = this.panel.ownerDocument;
    this.window = this.document.defaultView;

    if (this.input.megabar) {
      this.panel.classList.add("megabar");
    }

    this._mainContainer = this.panel.querySelector(".urlbarView-body-inner");
    this._rows = this.panel.querySelector(".urlbarView-results");

    this._rows.addEventListener("mousedown", this);
    this._rows.addEventListener("mouseup", this);

    // For the horizontal fade-out effect, set the overflow attribute on result
    // rows when they overflow.
    this._rows.addEventListener("overflow", this);
    this._rows.addEventListener("underflow", this);

    this.window.gBrowser.tabContainer.addEventListener("TabSelect", this);

    this.controller.setView(this);
    this.controller.addQueryListener(this);
  }

  get oneOffSearchButtons() {
    if (!this._oneOffSearchButtons) {
      this._oneOffSearchButtons = new this.window.SearchOneOffs(
        this.panel.querySelector(".search-one-offs")
      );
      this._oneOffSearchButtons.addEventListener(
        "SelectedOneOffButtonChanged",
        this
      );
    }
    return this._oneOffSearchButtons;
  }

  /**
   * @returns {boolean}
   *   Whether the panel is open.
   */
  get isOpen() {
    return this.input.hasAttribute("open");
  }

  get allowEmptySelection() {
    return !(
      this._queryContext &&
      this._queryContext.results[0] &&
      this._queryContext.results[0].heuristic
    );
  }

  get selectedRowIndex() {
    if (!this.isOpen) {
      return -1;
    }

    let selectedRow = this._getSelectedRow();

    if (!selectedRow) {
      return -1;
    }

    return selectedRow.result.rowIndex;
  }

  set selectedRowIndex(val) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    if (val < 0) {
      this._selectElement(null);
      return val;
    }

    let items = Array.from(this._rows.children).filter(r =>
      this._isElementVisible(r)
    );
    if (val >= items.length) {
      throw new Error(`UrlbarView: Index ${val} is out of bounds.`);
    }
    this._selectElement(items[val]);
    return val;
  }

  get selectedElementIndex() {
    if (!this.isOpen || !this._selectedElement) {
      return -1;
    }

    return this._selectedElement.elementIndex;
  }

  set selectedElementIndex(val) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    if (val < 0) {
      this._selectElement(null);
      return val;
    }

    let selectableElement = this._getFirstSelectableElement();
    while (selectableElement && selectableElement.elementIndex != val) {
      selectableElement = this._getNextSelectableElement(selectableElement);
    }

    if (!selectableElement) {
      throw new Error(`UrlbarView: Index ${val} is out of bounds.`);
    }

    this._selectElement(selectableElement);
    return val;
  }

  /**
   * @returns {UrlbarResult}
   *   The currently selected result.
   */
  get selectedResult() {
    if (!this.isOpen) {
      return null;
    }

    let selectedRow = this._getSelectedRow();

    if (!selectedRow) {
      return null;
    }

    return selectedRow.result;
  }

  /**
   * @returns {Element}
   *   The currently selected element.
   */
  get selectedElement() {
    if (!this.isOpen) {
      return null;
    }

    return this._selectedElement;
  }

  /**
   * @returns {number}
   *   The number of visible results in the view.  Note that this may be larger
   *   than the number of results in the current query context since the view
   *   may be showing stale results.
   */
  get visibleRowCount() {
    let sum = 0;
    for (let row of this._rows.children) {
      sum += Number(this._isElementVisible(row));
    }
    return sum;
  }

  /**
   * @returns {number}
   *   The number of selectable elements in the view.
   */
  get visibleElementCount() {
    let sum = 0;
    let element = this._getFirstSelectableElement();
    while (element) {
      if (this._isElementVisible(element)) {
        sum++;
      }
      element = this._getNextSelectableElement(element);
    }
    return sum;
  }

  /**
   * Returns the result of the row containing the given element, or the result
   * of the element if it itself is a row.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {UrlbarResult}
   *   The result of the element's row.
   */
  getResultFromElement(element) {
    if (!this.isOpen) {
      return null;
    }

    let row = this._getRowFromElement(element);

    if (!row) {
      return null;
    }

    return row.result;
  }

  /**
   * Returns the element closest to the given element that can be
   * selected/picked.  If the element itself can be selected, it's returned.  If
   * there is no such element, null is returned.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {Element}
   *   The closest element that can be picked including the element itself, or
   *   null if there is no such element.
   */
  getClosestSelectableElement(element) {
    let result = this.getResultFromElement(element);
    if (result && result.type == UrlbarUtils.RESULT_TYPE.TIP) {
      if (
        element.classList.contains("urlbarView-tip-button") ||
        element.classList.contains("urlbarView-tip-help")
      ) {
        return element;
      }
      return null;
    }
    return element.closest(".urlbarView-row");
  }

  /**
   * Moves the view selection forward or backward.
   *
   * @param {number} amount
   *   The number of steps to move.
   * @param {boolean} options.reverse
   *   Set to true to select the previous item. By default the next item
   *   will be selected.
   */
  selectBy(amount, { reverse = false } = {}) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    // Freeze results as the user is interacting with them.
    this.controller.cancelQuery();

    let selectedElement = this._selectedElement;

    // We cache the first and last rows since they will not change while
    // selectBy is running.
    let firstSelectableElement = this._getFirstSelectableElement();
    // _getLastSelectableElement will not return an element that is over
    // maxResults and thus may be hidden and not selectable.
    let lastSelectableElement = this._getLastSelectableElement();

    if (!selectedElement) {
      this._selectElement(
        reverse ? lastSelectableElement : firstSelectableElement
      );
      return;
    }
    let endReached = reverse
      ? selectedElement == firstSelectableElement
      : selectedElement == lastSelectableElement;
    if (endReached) {
      if (this.allowEmptySelection) {
        selectedElement = null;
      } else {
        selectedElement = reverse
          ? lastSelectableElement
          : firstSelectableElement;
      }
      this._selectElement(selectedElement);
      return;
    }

    while (amount-- > 0) {
      let next = reverse
        ? this._getPreviousSelectableElement(selectedElement)
        : this._getNextSelectableElement(selectedElement);
      if (!next) {
        break;
      }
      if (!this._isElementVisible(next)) {
        continue;
      }
      selectedElement = next;
    }
    this._selectElement(selectedElement);
  }

  removeAccessibleFocus() {
    this._setAccessibleFocus(null);
  }

  clear() {
    this._rows.textContent = "";
  }

  /**
   * Closes the view, cancelling the query if necessary.
   */
  close() {
    this.controller.cancelQuery();

    if (!this.isOpen) {
      return;
    }

    this.removeAccessibleFocus();
    this.input.inputField.setAttribute("aria-expanded", "false");
    this.input.dropmarker.removeAttribute("open");

    this.input.removeAttribute("open");
    this.input.endLayoutExtend();

    if (!this.input.megabar && this.input._toolbar) {
      this.input._toolbar.removeAttribute("urlbar-exceeds-toolbar-bounds");
    }

    this.window.removeEventListener("resize", this);

    this.controller.notify(this.controller.NOTIFICATIONS.VIEW_CLOSE);
  }

  maybeReopen() {
    // Reopen if we have cached results and the input is focused, unless the
    // search string is empty or different. We don't restore the empty search
    // because this is supposed to restore the search status when the user
    // abandoned a search engagement, just opening the dropdown is not
    // considered a sufficient engagement.
    if (
      this.input.megabar &&
      this._rows.firstElementChild &&
      this.input.focused &&
      this.input.value &&
      this._queryContext.searchString == this.input.value &&
      this.input.getAttribute("pageproxystate") != "valid"
    ) {
      // In some cases where we can move across tabs with an open panel.
      if (!this.isOpen) {
        this._openPanel();
      }
      this.input.startQuery({
        autofillIgnoresSelection: true,
        searchString: this.input.value,
        allowAutofill: this._queryContext.allowAutofill,
      });
      return true;
    }
    return false;
  }

  // UrlbarController listener methods.
  onQueryStarted(queryContext) {
    this._queryWasCancelled = false;
    this._startRemoveStaleRowsTimer();
  }

  onQueryCancelled(queryContext) {
    this._queryWasCancelled = true;
    this._cancelRemoveStaleRowsTimer();
  }

  onQueryFinished(queryContext) {
    this._cancelRemoveStaleRowsTimer();
    // If the query has not been canceled, remove stale rows immediately.
    if (!this._queryWasCancelled) {
      this._removeStaleRows();
    }
  }

  onQueryResults(queryContext) {
    this._queryContext = queryContext;

    if (!this.isOpen) {
      this.clear();
    }
    this._updateResults(queryContext);

    let isHeuristicResult = false;
    if (queryContext.lastResultCount == 0) {
      let firstResult = queryContext.results[0];

      if (firstResult.heuristic) {
        isHeuristicResult = true;
        this._selectElement(this._getFirstSelectableElement(), {
          updateInput: false,
          setAccessibleFocus: this.controller._userSelectionBehavior == "arrow",
        });
      } else {
        // Clear the selection when we get a new set of results.
        this._selectElement(null, {
          updateInput: false,
        });
      }
      // Hide the one-off search buttons if the search string is empty, or
      // starts with a potential @ search alias or the search restriction
      // character.
      let trimmedValue = queryContext.searchString.trim();
      this._enableOrDisableOneOffSearches(
        trimmedValue &&
          trimmedValue[0] != "@" &&
          (trimmedValue[0] != UrlbarTokenizer.RESTRICT.SEARCH ||
            trimmedValue.length != 1)
      );

      // The input field applies autofill on input, without waiting for results.
      // Once we get results, we can ask it to correct wrong predictions.
      this.input.maybeClearAutofillPlaceholder(firstResult);
    }

    this._openPanel();

    if (isHeuristicResult) {
      // The heuristic result may be a search alias result, so apply formatting
      // if necessary.  Conversely, the heuristic result of the previous query
      // may have been an alias, so remove formatting if necessary.
      this.input.formatValue();
    }
  }

  /**
   * Handles removing a result from the view when it is removed from the query,
   * and attempts to select the new result on the same row.
   *
   * This assumes that the result rows are in index order.
   *
   * @param {number} index The index of the result that has been removed.
   */
  onQueryResultRemoved(index) {
    let rowToRemove = this._rows.children[index];
    rowToRemove.remove();

    this._updateIndices();

    if (rowToRemove != this._getSelectedRow()) {
      return;
    }

    // Select the row at the same index, if possible.
    let newSelectionIndex = index;
    if (index >= this._queryContext.results.length) {
      newSelectionIndex = this._queryContext.results.length - 1;
    }
    if (newSelectionIndex >= 0) {
      this.selectedRowIndex = newSelectionIndex;
    }
  }

  /**
   * Passes DOM events for the view to the _on_<event type> methods.
   * @param {Event} event
   *   DOM event from the <view>.
   */
  handleEvent(event) {
    let methodName = "_on_" + event.type;
    if (methodName in this) {
      this[methodName](event);
    } else {
      throw new Error("Unrecognized UrlbarView event: " + event.type);
    }
  }

  /**
   * This is called when a one-off is clicked and when "search in new tab"
   * is selected from a one-off context menu.
   * @param {Event} event
   * @param {nsISearchEngine} engine
   * @param {string} where
   * @param {object} params
   */
  handleOneOffSearch(event, engine, where, params) {
    this.input.handleCommand(event, where, params);
  }

  // Private methods below.

  _createElement(name) {
    return this.document.createElementNS("http://www.w3.org/1999/xhtml", name);
  }

  _openPanel() {
    if (this.isOpen) {
      return;
    }
    this.controller.userSelectionBehavior = "none";

    this.panel.removeAttribute("actionoverride");

    if (!this.input.megabar) {
      let px = number => number.toFixed(2) + "px";
      let inputRect = getBoundsWithoutFlushing(this.input.textbox);

      // Make the panel span the width of the window.
      let documentRect = getBoundsWithoutFlushing(
        this.document.documentElement
      );
      let width = documentRect.right - documentRect.left;

      // Keep the popup items' site icons aligned with the input's identity
      // icon if it's not too far from the edge of the window.  We define
      // "too far" as "more than 30% of the window's width AND more than
      // 250px".
      let boundToCheck = this.window.RTL_UI ? "right" : "left";
      let startOffset = Math.abs(
        inputRect[boundToCheck] - documentRect[boundToCheck]
      );
      let alignSiteIcons = startOffset / width <= 0.3 || startOffset <= 250;

      if (alignSiteIcons) {
        // Calculate the end margin if we have a start margin.
        let boundToCheckEnd = this.window.RTL_UI ? "left" : "right";
        let endOffset = Math.abs(
          inputRect[boundToCheckEnd] - documentRect[boundToCheckEnd]
        );
        if (endOffset > startOffset * 2) {
          // Provide more space when aligning would result in an unbalanced
          // margin. This allows the location bar to be moved to the start
          // of the navigation toolbar to reclaim space for results.
          endOffset = startOffset;
        }

        // Align the view's icons with the tracking protection or identity icon,
        // whichever is visible.
        let alignRect;
        for (let id of ["tracking-protection-icon-box", "identity-icon"]) {
          alignRect = getBoundsWithoutFlushing(
            this.document.getElementById(id)
          );
          if (alignRect.width > 0) {
            break;
          }
        }
        let start = this.window.RTL_UI
          ? documentRect.right - alignRect.right
          : alignRect.left;

        this.panel.style.setProperty("--item-padding-start", px(start));
        this.panel.style.setProperty("--item-padding-end", px(endOffset));
      } else {
        this.panel.style.removeProperty("--item-padding-start");
        this.panel.style.removeProperty("--item-padding-end");
      }

      // Align the panel with the parent toolbar.
      this.panel.style.top = px(
        getBoundsWithoutFlushing(this.input.textbox.closest("toolbar")).bottom
      );

      this._mainContainer.style.maxWidth = px(width);

      if (this.input._toolbar) {
        this.input._toolbar.setAttribute(
          "urlbar-exceeds-toolbar-bounds",
          "true"
        );
      }
    }

    this._enableOrDisableRowWrap();

    this.input.inputField.setAttribute("aria-expanded", "true");
    this.input.dropmarker.setAttribute("open", "true");

    this.input.setAttribute("open", "true");
    this.input.startLayoutExtend();

    this.window.addEventListener("resize", this);
    this._windowOuterWidth = this.window.outerWidth;

    this.controller.notify(this.controller.NOTIFICATIONS.VIEW_OPEN);
  }

  /**
   * Whether a result is a search suggestion.
   * @param {UrlbarResult} result The result to examine.
   * @returns {boolean} Whether the result is a search suggestion.
   */
  _resultIsSearchSuggestion(result) {
    return Boolean(
      result &&
        result.type == UrlbarUtils.RESULT_TYPE.SEARCH &&
        result.payload.suggestion
    );
  }

  /**
   * Checks whether the given row index can be update to the result we want
   * to apply. This is used in _updateResults to avoid flickering of results, by
   * reusing existing rows.
   * @param {number} rowIndex Index of the row to examine.
   * @param {UrlbarResult} result The result we'd like to apply.
   * @param {number} firstSearchSuggestionIndex Index of the first search suggestion.
   * @param {number} lastSearchSuggestionIndex Index of the last search suggestion.
   * @returns {boolean} Whether the row can be updated to this result.
   */
  _rowCanUpdateToResult(
    rowIndex,
    result,
    firstSearchSuggestionIndex,
    lastSearchSuggestionIndex
  ) {
    // The heuristic result must always be current, thus it's always compatible.
    if (result.heuristic) {
      return true;
    }
    let row = this._rows.children[rowIndex];
    let resultIsSearchSuggestion = this._resultIsSearchSuggestion(result);
    // If the row is same type, just update it.
    if (
      resultIsSearchSuggestion == this._resultIsSearchSuggestion(row.result)
    ) {
      return true;
    }
    // If the row has a different type, update it if we are in a compatible
    // index range.
    // In practice we don't want to overwrite a search suggestion with a non
    // search suggestion, but we allow the opposite.
    return resultIsSearchSuggestion && rowIndex >= firstSearchSuggestionIndex;
  }

  _updateResults(queryContext) {
    // TODO: For now this just compares search suggestions to the rest, in the
    // future we should make it support any type of result. Or, even better,
    // results should be grouped, thus we can directly update groups.

    // Find where are existing search suggestions.
    let firstSearchSuggestionIndex = -1;
    let lastSearchSuggestionIndex = -1;
    for (let i = 0; i < this._rows.children.length; ++i) {
      let row = this._rows.children[i];
      // Mark every row as stale, _updateRow will unmark them later.
      row.setAttribute("stale", "true");
      // Skip any row that isn't a search suggestion, or is non-visible because
      // over maxResults.
      if (
        row.result.heuristic ||
        i >= queryContext.maxResults ||
        !this._resultIsSearchSuggestion(row.result)
      ) {
        continue;
      }
      if (firstSearchSuggestionIndex == -1) {
        firstSearchSuggestionIndex = i;
      }
      lastSearchSuggestionIndex = i;
    }

    // Walk rows and find an insertion index for results. To avoid flicker, we
    // skip rows until we find one compatible with the result we want to apply.
    // If we couldn't find a compatible range, we'll just update.
    let results = queryContext.results;
    let resultIndex = 0;
    // We can have more rows than the visible ones.
    for (
      let rowIndex = 0;
      rowIndex < this._rows.children.length && resultIndex < results.length;
      ++rowIndex
    ) {
      let row = this._rows.children[rowIndex];
      let result = results[resultIndex];
      if (
        this._rowCanUpdateToResult(
          rowIndex,
          result,
          firstSearchSuggestionIndex,
          lastSearchSuggestionIndex
        )
      ) {
        this._updateRow(row, result);
        resultIndex++;
      }
    }
    // Add remaining results, if we have fewer rows than results.
    for (; resultIndex < results.length; ++resultIndex) {
      let row = this._createRow();
      this._updateRow(row, results[resultIndex]);
      // Due to stale rows, we may have more rows than maxResults, thus we must
      // hide them, and we'll revert this when stale rows are removed.
      if (this._rows.children.length >= queryContext.maxResults) {
        this._setRowVisibility(row, false);
      }
      this._rows.appendChild(row);
    }

    this._updateIndices();
  }

  _createRow() {
    let item = this._createElement("div");
    item.className = "urlbarView-row";
    item.setAttribute("role", "option");
    item._elements = new Map();
    return item;
  }

  _createRowContent(item) {
    // The url is the only element that can wrap, thus all the other elements
    // are child of noWrap.
    let noWrap = this._createElement("span");
    noWrap.className = "urlbarView-no-wrap";
    item._content.appendChild(noWrap);

    let typeIcon = this._createElement("span");
    typeIcon.className = "urlbarView-type-icon";

    if (!this.input.megabar) {
      noWrap.appendChild(typeIcon);
    }

    let favicon = this._createElement("img");
    favicon.className = "urlbarView-favicon";
    noWrap.appendChild(favicon);
    item._elements.set("favicon", favicon);

    if (this.input.megabar) {
      noWrap.appendChild(typeIcon);
    }

    let title = this._createElement("span");
    title.className = "urlbarView-title";
    noWrap.appendChild(title);
    item._elements.set("title", title);

    let tagsContainer = this._createElement("span");
    tagsContainer.className = "urlbarView-tags";
    noWrap.appendChild(tagsContainer);
    item._elements.set("tagsContainer", tagsContainer);

    let titleSeparator = this._createElement("span");
    titleSeparator.className = "urlbarView-title-separator";
    noWrap.appendChild(titleSeparator);
    item._elements.set("titleSeparator", titleSeparator);

    let action = this._createElement("span");
    action.className = "urlbarView-action";
    noWrap.appendChild(action);
    item._elements.set("action", action);

    let url = this._createElement("span");
    url.className = "urlbarView-url";
    item._content.appendChild(url);
    item._elements.set("url", url);
  }

  _createRowContentForTip(item) {
    // We use role="group" so screen readers will read the group's label when a
    // button inside it gets focus. (Screen readers don't do this for
    // role="option".) We set aria-labelledby for the group in _updateIndices.
    item._content.setAttribute("role", "group");

    let favicon = this._createElement("img");
    favicon.className = "urlbarView-favicon";
    item._content.appendChild(favicon);
    item._elements.set("favicon", favicon);

    let title = this._createElement("span");
    title.className = "urlbarView-title";
    item._content.appendChild(title);
    item._elements.set("title", title);

    let buttonSpacer = this._createElement("span");
    buttonSpacer.className = "urlbarView-tip-button-spacer";
    item._content.appendChild(buttonSpacer);

    let tipButton = this._createElement("span");
    tipButton.className = "urlbarView-tip-button";
    tipButton.setAttribute("role", "button");
    item._content.appendChild(tipButton);
    item._elements.set("tipButton", tipButton);

    let helpIcon = this._createElement("span");
    helpIcon.className = "urlbarView-tip-help";
    helpIcon.setAttribute("role", "button");
    helpIcon.setAttribute("data-l10n-id", "urlbar-tip-help-icon");
    item._elements.set("helpButton", helpIcon);
    item._content.appendChild(helpIcon);

    // Due to role=button, the button and help icon can sometimes become
    // focused.  We want to prevent that because the input should always be
    // focused instead.  (This happens when input.search("", { focus: false })
    // is called, a tip is the first result but not heuristic, and the user tabs
    // the into the button from the navbar buttons.  The input is skipped and
    // the focus goes straight to the tip button.)
    item.addEventListener("focus", () => this.input.focus(), true);
  }

  _updateRow(item, result) {
    let oldResultType = item.result && item.result.type;
    item.result = result;
    item.removeAttribute("stale");

    let needsNewContent =
      oldResultType === undefined ||
      (oldResultType == UrlbarUtils.RESULT_TYPE.TIP) !=
        (result.type == UrlbarUtils.RESULT_TYPE.TIP);

    if (needsNewContent) {
      if (item._content) {
        item._content.remove();
        item._elements.clear();
      }
      item._content = this._createElement("span");
      item._content.className = "urlbarView-row-inner";
      item.appendChild(item._content);
      if (item.result.type == UrlbarUtils.RESULT_TYPE.TIP) {
        this._createRowContentForTip(item);
      } else {
        this._createRowContent(item);
      }
    }

    if (
      result.type == UrlbarUtils.RESULT_TYPE.SEARCH &&
      !result.payload.keywordOffer &&
      !result.payload.inPrivateWindow
    ) {
      item.setAttribute("type", "search");
    } else if (result.type == UrlbarUtils.RESULT_TYPE.REMOTE_TAB) {
      item.setAttribute("type", "remotetab");
    } else if (result.type == UrlbarUtils.RESULT_TYPE.TAB_SWITCH) {
      item.setAttribute("type", "switchtab");
    } else if (result.type == UrlbarUtils.RESULT_TYPE.TIP) {
      item.setAttribute("type", "tip");
      this._updateRowForTip(item, result);
      return;
    } else if (result.source == UrlbarUtils.RESULT_SOURCE.BOOKMARKS) {
      item.setAttribute("type", "bookmark");
    } else {
      item.removeAttribute("type");
    }

    let favicon = item._elements.get("favicon");
    if (
      result.type == UrlbarUtils.RESULT_TYPE.SEARCH ||
      result.type == UrlbarUtils.RESULT_TYPE.KEYWORD
    ) {
      favicon.src = result.payload.icon || UrlbarUtils.ICON.SEARCH_GLASS;
    } else {
      favicon.src = result.payload.icon || UrlbarUtils.ICON.DEFAULT;
    }

    let title = item._elements.get("title");
    this._addTextContentWithHighlights(
      title,
      result.title,
      result.titleHighlights
    );
    title._tooltip = result.title;
    if (title.hasAttribute("overflow")) {
      title.setAttribute("title", title._tooltip);
    }

    let tagsContainer = item._elements.get("tagsContainer");
    tagsContainer.textContent = "";
    if (result.payload.tags && result.payload.tags.length) {
      tagsContainer.append(
        ...result.payload.tags.map((tag, i) => {
          const element = this._createElement("span");
          element.className = "urlbarView-tag";
          this._addTextContentWithHighlights(
            element,
            tag,
            result.payloadHighlights.tags[i]
          );
          return element;
        })
      );
    }

    let action = "";
    let isVisitAction = false;
    let setURL = false;
    switch (result.type) {
      case UrlbarUtils.RESULT_TYPE.TAB_SWITCH:
        action = UrlbarUtils.strings.GetStringFromName("switchToTab2");
        setURL = true;
        break;
      case UrlbarUtils.RESULT_TYPE.REMOTE_TAB:
        action = result.payload.device;
        setURL = true;
        break;
      case UrlbarUtils.RESULT_TYPE.SEARCH:
        if (result.payload.inPrivateWindow) {
          if (result.payload.isPrivateEngine) {
            action = UrlbarUtils.strings.formatStringFromName(
              "searchInPrivateWindowWithEngine",
              [result.payload.engine]
            );
          } else {
            action = UrlbarUtils.strings.GetStringFromName(
              "searchInPrivateWindow"
            );
          }
        } else {
          action = UrlbarUtils.strings.formatStringFromName(
            "searchWithEngine",
            [result.payload.engine]
          );
        }
        break;
      case UrlbarUtils.RESULT_TYPE.KEYWORD:
        isVisitAction = result.payload.input.trim() == result.payload.keyword;
        break;
      case UrlbarUtils.RESULT_TYPE.OMNIBOX:
        action = result.payload.content;
        break;
      default:
        if (result.heuristic) {
          isVisitAction = true;
        } else {
          setURL = true;
        }
        break;
    }

    let url = item._elements.get("url");
    if (setURL) {
      item.setAttribute("has-url", "true");
      this._addTextContentWithHighlights(
        url,
        result.payload.displayUrl,
        result.payloadHighlights.displayUrl || []
      );
      url._tooltip = result.payload.displayUrl;
    } else {
      item.removeAttribute("has-url");
      url.textContent = "";
      url._tooltip = "";
    }
    if (url.hasAttribute("overflow")) {
      url.setAttribute("title", url._tooltip);
    }

    if (isVisitAction) {
      action = UrlbarUtils.strings.GetStringFromName("visit");
      title.setAttribute("isurl", "true");
    } else {
      title.removeAttribute("isurl");
    }
    item._elements.get("action").textContent = action;

    if (!title.hasAttribute("isurl")) {
      title.setAttribute("dir", "auto");
    } else {
      title.removeAttribute("dir");
    }

    item._elements.get("titleSeparator").hidden = !action && !setURL;
  }

  _updateRowForTip(item, result) {
    let favicon = item._elements.get("favicon");
    favicon.src = result.payload.icon || UrlbarUtils.ICON.TIP;

    let title = item._elements.get("title");
    title.textContent = result.payload.text;

    let tipButton = item._elements.get("tipButton");
    tipButton.textContent = result.payload.buttonText;

    let helpIcon = item._elements.get("helpButton");
    helpIcon.style.display = result.payload.helpUrl ? "" : "none";
  }

  _updateIndices() {
    for (let i = 0; i < this._rows.children.length; i++) {
      let item = this._rows.children[i];
      item.result.rowIndex = i;
      item.id = "urlbarView-row-" + i;
      if (item.result.type == UrlbarUtils.RESULT_TYPE.TIP) {
        let title = item._elements.get("title");
        title.id = item.id + "-title";
        item._content.setAttribute("aria-labelledby", title.id);
        let tipButton = item._elements.get("tipButton");
        tipButton.id = item.id + "-tip-button";
        let helpButton = item._elements.get("helpButton");
        helpButton.id = item.id + "-tip-help";
      }
    }
    let selectableElement = this._getFirstSelectableElement();
    let uiIndex = 0;
    while (selectableElement) {
      selectableElement.elementIndex = uiIndex++;
      selectableElement = this._getNextSelectableElement(selectableElement);
    }
  }

  _setRowVisibility(row, visible) {
    row.style.display = visible ? "" : "none";
    if (!visible && row.result.type != UrlbarUtils.RESULT_TYPE.TIP) {
      // Reset the overflow state of elements that can overflow in case their
      // content changes while they're hidden. When making the row visible
      // again, we'll get new overflow events if needed.
      this._setElementOverflowing(row._elements.get("title"), false);
      this._setElementOverflowing(row._elements.get("url"), false);
    }
  }

  /**
   * Returns true if a row or a descendant in the view is visible.
   *
   * @param {Element} element
   *   A row in the view or a descendant of the row.
   * @returns {boolean}
   *   True if `element` or `element`'s ancestor row is visible in the view.
   */
  _isElementVisible(element) {
    if (!element.classList.contains("urlbarView-row")) {
      element = element.closest(".urlbarView-row");
    }

    if (!element) {
      return false;
    }

    return element.style.display != "none";
  }

  _removeStaleRows() {
    let row = this._rows.lastElementChild;
    while (row) {
      let next = row.previousElementSibling;
      if (row.hasAttribute("stale")) {
        row.remove();
      } else {
        this._setRowVisibility(row, true);
      }
      row = next;
    }
    this._updateIndices();
  }

  _startRemoveStaleRowsTimer() {
    this._removeStaleRowsTimer = this.window.setTimeout(() => {
      this._removeStaleRowsTimer = null;
      this._removeStaleRows();
    }, UrlbarView.removeStaleRowsTimeout);
  }

  _cancelRemoveStaleRowsTimer() {
    if (this._removeStaleRowsTimer) {
      this.window.clearTimeout(this._removeStaleRowsTimer);
      this._removeStaleRowsTimer = null;
    }
  }

  _selectElement(item, { updateInput = true, setAccessibleFocus = true } = {}) {
    if (this._selectedElement) {
      this._selectedElement.toggleAttribute("selected", false);
      this._selectedElement.removeAttribute("aria-selected");
    }
    if (item) {
      item.toggleAttribute("selected", true);
      item.setAttribute("aria-selected", "true");
    }
    this._setAccessibleFocus(setAccessibleFocus && item);
    this._selectedElement = item;

    if (updateInput) {
      this.input.setValueFromResult(item && item.result);
    }
  }

  /**
   * Returns the first selectable element in the view.
   *
   * @returns {Element} The first selectable element in the view.
   */
  _getFirstSelectableElement() {
    let firstElementChild = this._rows.firstElementChild;
    if (
      firstElementChild &&
      firstElementChild.result &&
      firstElementChild.result.type == UrlbarUtils.RESULT_TYPE.TIP
    ) {
      firstElementChild = firstElementChild._elements.get("tipButton");
    }
    return firstElementChild;
  }

  /**
   * Returns the last selectable element in the view.
   *
   * @returns {Element} The last selectable element in the view.
   */
  _getLastSelectableElement() {
    let lastElementChild = this._rows.lastElementChild;

    // We are only interested in visible elements.
    while (lastElementChild && !this._isElementVisible(lastElementChild)) {
      lastElementChild = this._getPreviousSelectableElement(lastElementChild);
    }

    if (
      lastElementChild.result &&
      lastElementChild.result.type == UrlbarUtils.RESULT_TYPE.TIP
    ) {
      lastElementChild = lastElementChild._elements.get("helpButton");
      if (lastElementChild.style.display == "none") {
        lastElementChild = this._getPreviousSelectableElement(lastElementChild);
      }
    }

    return lastElementChild;
  }

  /**
   * Returns the next selectable element after the parameter `element`.
   * @param {Element} element A selectable element in the view.
   * @returns {Element} The next selectable element after the parameter `element`.
   */
  _getNextSelectableElement(element) {
    let next;
    if (element.classList.contains("urlbarView-tip-button")) {
      next = element.closest(".urlbarView-row")._elements.get("helpButton");
      if (next.style.display == "none") {
        next = this._getNextSelectableElement(next);
      }
    } else if (element.classList.contains("urlbarView-tip-help")) {
      next = element.closest(".urlbarView-row").nextElementSibling;
    } else {
      next = element.nextElementSibling;
    }

    if (!next) {
      return null;
    }

    if (next.result && next.result.type == UrlbarUtils.RESULT_TYPE.TIP) {
      next = next._elements.get("tipButton");
    }

    return next;
  }

  /**
   * Returns the previous selectable element before the parameter `element`.
   * @param {Element} element A selectable element in the view.
   * @returns {Element} The previous selectable element before the parameter `element`.
   */
  _getPreviousSelectableElement(element) {
    let previous;
    if (element.classList.contains("urlbarView-tip-button")) {
      previous = element.closest(".urlbarView-row").previousElementSibling;
    } else if (element.classList.contains("urlbarView-tip-help")) {
      previous = element.closest(".urlbarView-row")._elements.get("tipButton");
    } else {
      previous = element.previousElementSibling;
    }

    if (!previous) {
      return null;
    }

    if (
      previous.result &&
      previous.result.type == UrlbarUtils.RESULT_TYPE.TIP
    ) {
      previous = previous._elements.get("helpButton");
      if (previous.style.display == "none") {
        previous = this._getPreviousSelectableElement(previous);
      }
    }

    return previous;
  }

  /**
   * Returns the currently selected row. Useful when this._selectedElement may be a
   * non-row element, such as a descendant element of RESULT_TYPE.TIP.
   *
   * @returns {Element}
   *   The currently selected row, or ancestor row of the currently selected item.
   *
   */
  _getSelectedRow() {
    if (!this.isOpen || !this._selectedElement) {
      return null;
    }
    let selected = this._selectedElement;

    if (!selected.classList.contains("urlbarView-row")) {
      // selected may be an element in a result group, like RESULT_TYPE.TIP.
      selected = selected.closest(".urlbarView-row");
    }

    return selected;
  }

  /**
   * @param {Element} element
   *   An element that is potentially a row or descendant of a row.
   * @returns {Element}
   *   The row containing `element`, or `element` itself if it is a row.
   */
  _getRowFromElement(element) {
    if (!this.isOpen || !element) {
      return null;
    }

    if (!element.classList.contains("urlbarView-row")) {
      element = element.closest(".urlbarView-row");
    }

    return element;
  }

  _setAccessibleFocus(item) {
    if (item) {
      this.input.inputField.setAttribute("aria-activedescendant", item.id);
    } else {
      this.input.inputField.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * Adds text content to a node, placing substrings that should be highlighted
   * inside <em> nodes.
   *
   * @param {Node} parentNode
   *   The text content will be added to this node.
   * @param {string} textContent
   *   The text content to give the node.
   * @param {array} highlights
   *   The matches to highlight in the text.
   */
  _addTextContentWithHighlights(parentNode, textContent, highlights) {
    parentNode.textContent = "";
    if (!textContent) {
      return;
    }
    highlights = (highlights || []).concat([[textContent.length, 0]]);
    let index = 0;
    for (let [highlightIndex, highlightLength] of highlights) {
      if (highlightIndex - index > 0) {
        parentNode.appendChild(
          this.document.createTextNode(
            textContent.substring(index, highlightIndex)
          )
        );
      }
      if (highlightLength > 0) {
        let strong = this._createElement("strong");
        strong.textContent = textContent.substring(
          highlightIndex,
          highlightIndex + highlightLength
        );
        parentNode.appendChild(strong);
      }
      index = highlightIndex + highlightLength;
    }
  }

  _enableOrDisableOneOffSearches(enable = true) {
    if (enable && UrlbarPrefs.get("oneOffSearches")) {
      this.oneOffSearchButtons.telemetryOrigin = "urlbar";
      this.oneOffSearchButtons.style.display = "";
      this.oneOffSearchButtons.textbox = this.input.inputField;
      this.oneOffSearchButtons.view = this;
    } else {
      this.oneOffSearchButtons.telemetryOrigin = null;
      this.oneOffSearchButtons.style.display = "none";
      this.oneOffSearchButtons.textbox = null;
      this.oneOffSearchButtons.view = null;
    }
  }

  _enableOrDisableRowWrap() {
    if (getBoundsWithoutFlushing(this.input.textbox).width <= 500) {
      this._rows.setAttribute("wrap", "true");
    } else {
      this._rows.removeAttribute("wrap");
    }
  }

  _setElementOverflowing(element, overflowing) {
    element.toggleAttribute("overflow", overflowing);
    if (overflowing) {
      element.setAttribute("title", element._tooltip);
    } else {
      element.removeAttribute("title");
    }
  }

  // Event handlers below.

  _on_SelectedOneOffButtonChanged() {
    if (!this.isOpen || !this._queryContext) {
      return;
    }

    // Update all search suggestion results to use the newly selected engine, or
    // if no engine is selected, revert to their original engines.
    let engine =
      this.oneOffSearchButtons.selectedButton &&
      this.oneOffSearchButtons.selectedButton.engine;
    for (let i = 0; i < this._queryContext.results.length; i++) {
      let result = this._queryContext.results[i];
      if (
        result.type != UrlbarUtils.RESULT_TYPE.SEARCH ||
        (!result.heuristic &&
          !result.payload.suggestion &&
          (!result.payload.inPrivateWindow || result.payload.isPrivateEngine))
      ) {
        continue;
      }
      if (engine) {
        if (!result.payload.originalEngine) {
          result.payload.originalEngine = result.payload.engine;
        }
        result.payload.engine = engine.name;
      } else if (result.payload.originalEngine) {
        result.payload.engine = result.payload.originalEngine;
        delete result.payload.originalEngine;
      }
      let item = this._rows.children[i];
      // If a one-off button is the only selection, force the heuristic result
      // to show its action text, so the engine name is visible.
      if (result.heuristic && engine && !this.selectedElement) {
        item.setAttribute("show-action-text", "true");
      } else {
        item.removeAttribute("show-action-text");
      }
      if (!result.payload.inPrivateWindow) {
        let action = item.querySelector(".urlbarView-action");
        action.textContent = UrlbarUtils.strings.formatStringFromName(
          "searchWithEngine",
          [(engine && engine.name) || result.payload.engine]
        );
      }
      // If we just changed the engine from the original engine and it had an
      // icon, then make sure the result now uses the new engine's icon or
      // failing that the default icon.  If we changed it back to the original
      // engine, go back to the original or default icon.
      let favicon = item.querySelector(".urlbarView-favicon");
      if (engine && result.payload.icon) {
        favicon.src =
          (engine.iconURI && engine.iconURI.spec) ||
          UrlbarUtils.ICON.SEARCH_GLASS;
      } else if (!engine) {
        favicon.src = result.payload.icon || UrlbarUtils.ICON.SEARCH_GLASS;
      }
    }
  }

  _on_mousedown(event) {
    if (event.button == 2) {
      // Ignore right clicks.
      return;
    }
    let element = this.getClosestSelectableElement(event.target);
    if (!element) {
      // Ignore clicks on elements that can't be selected/picked.
      return;
    }
    this._selectElement(element, { updateInput: false });
    this.controller.speculativeConnect(
      this.selectedResult,
      this._queryContext,
      "mousedown"
    );
  }

  _on_mouseup(event) {
    if (event.button == 2) {
      // Ignore right clicks.
      return;
    }
    let element = this.getClosestSelectableElement(event.target);
    if (!element) {
      // Ignore clicks on elements that can't be selected/picked.
      return;
    }
    this.input.pickElement(element, event);
  }

  _on_overflow(event) {
    if (
      event.detail == 1 &&
      (event.target.classList.contains("urlbarView-url") ||
        event.target.classList.contains("urlbarView-title"))
    ) {
      this._setElementOverflowing(event.target, true);
    }
  }

  _on_underflow(event) {
    if (
      event.detail == 1 &&
      (event.target.classList.contains("urlbarView-url") ||
        event.target.classList.contains("urlbarView-title"))
    ) {
      this._setElementOverflowing(event.target, false);
    }
  }

  _on_resize() {
    if (this.input.megabar) {
      this._enableOrDisableRowWrap();
      return;
    }

    if (this._windowOuterWidth == this.window.outerWidth) {
      // Sometimes a resize event is fired when the window's size doesn't
      // actually change; at least, browser_tabMatchesInAwesomebar.js triggers
      // it intermittently, which causes that test to hang or fail.  Ignore
      // those events.
      return;
    }

    // Close the popup as it would be wrongly sized. This can
    // happen when using special OS resize functions like Win+Arrow.
    this.close();
  }

  _on_TabSelect() {
    // A TabSelect doesn't always change urlbar focus, so we must try to reopen
    // here too, not just on focus.
    if (this.maybeReopen()) {
      return;
    }
    // The input may retain focus when switching tabs in which case we
    // need to close the view explicitly.
    this.close();
  }
}

UrlbarView.removeStaleRowsTimeout = DEFAULT_REMOVE_STALE_ROWS_TIMEOUT;