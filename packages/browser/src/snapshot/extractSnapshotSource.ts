/**
 * Design §4.2. Plain-JS source of `function (config) => FormSnapshot`, evaluated inside the application page
 * (`page.evaluate` in the worker, `window.eval` in jsdom tests). It is a string, not a TS function, because tsx's
 * esbuild `keepNames` would inject `__name(...)` calls that do not exist in the page (DECISIONS D131).
 *
 * It stamps `data-cp-key` on every reported element so the worker can address it as `[data-cp-key="f3"]`.
 * Label text is untrusted page content: it is only ever regex-matched, never sent to a model.
 * Uses textContent (not innerText) so jsdom and Chrome agree.
 */
export const EXTRACT_SNAPSHOT_SOURCE = String.raw`function (config) {
  var form = document.querySelector(config.formSelector);
  if (!form) return { url: String(location.href), formFound: false, fields: [] };
  var SKIP_TYPES = { hidden: true, submit: true, button: true, image: true, reset: true };
  var counter = 0;
  function clean(text) {
    if (text === null || text === undefined) return null;
    var t = String(text).replace(/\s+/g, " ").trim().replace(/[\s*✱]+$/, "").trim();
    return t ? t.slice(0, 200) : null;
  }
  function textOf(el) { return el ? clean(el.textContent) : null; }
  function byIds(ids) {
    if (!ids) return null;
    var parts = ids.split(/\s+/).map(function (id) { var e = document.getElementById(id); return e ? e.textContent : ""; });
    return clean(parts.join(" "));
  }
  function labelForId(id) {
    if (!id) return null;
    var labels = form.querySelectorAll("label[for]");
    for (var i = 0; i < labels.length; i++) if (labels[i].getAttribute("for") === id) return textOf(labels[i]);
    return null;
  }
  function questionLabel(el) {
    var container = el.closest(config.questionContainer);
    if (!container) return null;
    return textOf(container.querySelector(config.questionLabel));
  }
  function labelOf(el) {
    return byIds(el.getAttribute("aria-labelledby")) || labelForId(el.id) || clean(el.getAttribute("aria-label")) ||
      questionLabel(el) || textOf(el.closest("label"));
  }
  function groupLabelOf(el) {
    var fieldset = el.closest("fieldset");
    return questionLabel(el) || (fieldset ? textOf(fieldset.querySelector("legend")) : null);
  }
  function controlOf(el) {
    var tag = el.tagName.toLowerCase();
    if (el.getAttribute("role") === "combobox" || el.hasAttribute("aria-autocomplete")) return "combobox";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "text" || type === "search") return "text";
    if (["email", "tel", "url", "number", "file", "checkbox", "radio"].indexOf(type) >= 0) return type;
    return "other";
  }
  function isRequired(el) {
    return el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
  }
  function stamp(el) { var key = "f" + counter++; el.setAttribute("data-cp-key", key); return key; }
  var fields = [];
  var groups = {};
  var elements = form.querySelectorAll("input, select, textarea");
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (SKIP_TYPES[type] || el.disabled || el.getAttribute("aria-hidden") === "true") continue;
    var control = controlOf(el);
    var name = el.getAttribute("name");
    if ((control === "radio" || control === "checkbox") && name) {
      var group = groups[name];
      if (!group) {
        group = { key: "g" + counter++, control: control === "radio" ? "radio_group" : "checkbox_group", name: name, id: null,
          autocomplete: null, label: groupLabelOf(el), required: false, options: [] };
        groups[name] = group;
        fields.push(group);
      }
      group.required = group.required || isRequired(el);
      group.options.push({ key: stamp(el), label: textOf(el.closest("label")) || clean(el.getAttribute("aria-label")) || "", value: el.value });
      continue;
    }
    var field = { key: stamp(el), control: control, name: name, id: el.id || null, autocomplete: el.getAttribute("autocomplete"),
      label: labelOf(el), required: isRequired(el), options: [] };
    if (control === "select") {
      for (var j = 0; j < el.options.length; j++) {
        var opt = el.options[j];
        field.options.push({ key: field.key, label: clean(opt.textContent) || "", value: opt.value });
      }
    }
    fields.push(field);
  }
  for (var n in groups) if (groups[n].control === "checkbox_group" && groups[n].options.length === 1) groups[n].control = "checkbox";
  return { url: String(location.href), formFound: true, fields: fields };
}`;
