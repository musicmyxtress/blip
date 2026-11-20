namespace BlipDesk;

// The form mirror: a page's form fields as real Windows controls.
//
//   Tab / Shift+Tab   move between fields, then the form's buttons, then Close
//   (leaving a field) sends that change to the page; check boxes change at once
//   Down Arrow        in a list-style field (after typing a few letters, if it takes typing):
//                     open the page's matching choices; Alt+Down Arrow works too
//   F5                read the form again from the page
//   Escape            close (a change you were typing is sent first)
//
// Nothing is submitted from here: the form's own buttons are listed at the end, and a button that
// may submit asks first, reading back every field as the page now has it.
public sealed class FormDialog : Form
{
    private sealed class Binding(DeskField field)
    {
        public DeskField Field { get; set; } = field;
        public Label? Label { get; set; }
        public Control Main { get; set; } = null!;
        public List<Control> Parts { get; } = [];
        public Func<Task> Commit { get; set; } = () => Task.CompletedTask;
        /// <summary>Set when the control names itself from the description (date dropdowns).</summary>
        public Action<string>? Rename { get; set; }
        public string Key => $"{Field.Kind}|{Field.Label}";
    }

    private static readonly HashSet<string> TypingTypes = ["", "text", "search", "email", "url", "tel"];

    private readonly DeskClient _client;
    private readonly string? _regionId;
    private readonly string _title;
    private readonly TextBox _summary = new()
    {
        ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, Width = 640, Height = 60,
        BackColor = SystemColors.Control, AccessibleName = "About this form", TabStop = true,
    };
    private readonly FlowLayoutPanel _panel = new()
    {
        Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(10),
    };
    private readonly List<Binding> _bindings = [];
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _updating;
    private bool _closingChecked;
    private int _tab;

    /// <summary>The button the user chose to press, for the main window to activate.</summary>
    public DeskControl? Chosen { get; private set; }
    /// <summary>True when the user already said yes to <see cref="Chosen"/>.</summary>
    public bool Confirmed { get; private set; }

    public FormDialog(DeskClient client, string? regionId, string title)
    {
        _client = client;
        _regionId = regionId;
        _title = title;
        Text = $"Blip Desk form - {title}";
        Width = 720;
        Height = 760;
        StartPosition = FormStartPosition.CenterParent;
        KeyPreview = true;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Controls.Add(_panel);
        _summary.Text = "Reading the form…";
        _panel.Controls.Add(_summary);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await ReloadAsync(focusKey: null);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.F5)
        {
            _ = RunAsync(() => ReloadAsync(FocusedKey()));
            return true;
        }
        if (keyData == Keys.Escape)
        {
            Close();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    // ---------------------------------------------------------------- reading the form

    /// <summary>Runs page work one step at a time, so a change and a button press never overlap.</summary>
    private async Task RunAsync(Func<Task> work)
    {
        await _gate.WaitAsync();
        try { await work(); }
        finally { _gate.Release(); }
    }

    private async Task ReloadAsync(string? focusKey)
    {
        FieldsResult result;
        try { result = await _client.GetFieldsAsync(_regionId); }
        catch (DeskException ex)
        {
            _summary.Text = ex.Message;
            _summary.Focus();
            return;
        }
        Build(result);
        var target = _bindings.FirstOrDefault(b => b.Key == focusKey)?.Main
            ?? _bindings.FirstOrDefault(b => b.Field.Invalid != "")?.Main;
        if (target is not null) target.Focus(); else _summary.Focus();
    }

    private void Build(FieldsResult result)
    {
        _updating = true;
        _panel.SuspendLayout();
        foreach (Control control in _panel.Controls.Cast<Control>().ToList())
        {
            if (control != _summary) { _panel.Controls.Remove(control); control.Dispose(); }
        }
        _bindings.Clear();
        _tab = 1;
        _summary.TabIndex = 0;

        foreach (var field in result.Fields) AddField(field);

        if (result.Controls.Count > 0)
        {
            Add(new Label { Text = "The form's buttons:", AutoSize = true, Margin = new Padding(3, 16, 3, 3) });
            foreach (var control in result.Controls)
            {
                var text = control.Access switch
                {
                    "confirm" => $"{control.Label} (asks first: {control.Note})",
                    "blocked" => $"{control.Label} (not allowed: {control.Note})",
                    _ => control.Label,
                };
                var button = new Button { Text = text, AutoSize = true, MinimumSize = new Size(200, 0), UseMnemonic = false };
                button.Click += async (_, _) => await PressAsync(control);
                Add(button);
            }
        }
        var close = new Button { Text = "Close", AutoSize = true, Margin = new Padding(3, 16, 3, 3) };
        close.Click += (_, _) => Close();
        Add(close);
        _panel.ResumeLayout();
        _updating = false;

        var required = result.Fields.Count(f => f.Required);
        var errors = result.Fields.Count(f => f.Invalid != "");
        var counts = $"{Count(result.Fields.Count, "field")}" + (required > 0 ? $", {required} required" : "") + (errors > 0 ? $", {Count(errors, "error")}" : "");
        _summary.Text = result.Fields.Count == 0
            ? $"{_title}: no fields Blip can fill here. Escape closes."
            : $"{_title}: {counts}. Tab moves between fields; each change goes to the page when you leave the field. " +
              "Nothing is sent until you press one of the form's buttons at the end. F5 reads the form again. Escape closes." +
              (result.Truncated ? " This form is very long; only the first 150 fields are shown." : "");
    }

    private void Add(Control control)
    {
        control.TabIndex = _tab++;
        _panel.Controls.Add(control);
    }

    private static string Count(int n, string noun) => n == 1 ? $"1 {noun}" : $"{n} {noun}s";

    private static string Describe(DeskField f)
    {
        var parts = new List<string> { f.Label };
        if (f.Required) parts.Add("required");
        if (f.Kind == "text" && !TypingTypes.Contains(f.InputType) && f.InputType != "password")
        {
            parts.Add(f.InputType switch { "text-date" => "date", "datetime-local" => "date and time", var other => other });
        }
        if (f.DateFormat is { } pattern)
        {
            var spoken = SpokenDateFormat(pattern);
            parts.Add(f.DateFormatSource == "page" ? $"page format {spoken}" : $"Blip's guess at the page's format: {spoken}");
        }
        if (f.MaxLength is > 0) parts.Add($"up to {f.MaxLength} characters");
        if (f.Disabled) parts.Add("turned off on the page");
        var text = string.Join(", ", parts);
        if (f.Invalid != "") text += $". Error: {f.Invalid}";
        if (f.Hint != "") text += $". {f.Hint}";
        return text;
    }

    // ---------------------------------------------------------------- one control per field

    private void AddField(DeskField field)
    {
        var binding = new Binding(field);
        _bindings.Add(binding);
        switch (field.Kind)
        {
            case "text" when (field.InputType is "date" or "time" or "datetime-local" || field.DateFormat is not null) && !field.Sensitive: AddDate(binding); break;
            case "text" or "textarea": AddText(binding); break;
            case "select": AddSelect(binding); break;
            case "checkbox": AddCheckBox(binding); break;
            case "radio": AddRadio(binding); break;
            case "combobox": AddCombo(binding); break;
            default: AddOther(binding); break;
        }
    }

    private Label AddLabel(Binding binding)
    {
        // The label sits right before its control in tab order, so screen readers use it as the name.
        var label = new Label { Text = Describe(binding.Field), AutoSize = true, MaximumSize = new Size(640, 0), Margin = new Padding(3, 10, 3, 2), UseMnemonic = false };
        Add(label);
        binding.Label = label;
        return label;
    }

    private void AddText(Binding binding)
    {
        var f = binding.Field;
        AddLabel(binding);
        var multiline = f.Kind == "textarea";
        var box = new TextBox
        {
            Width = 640, Multiline = multiline, AcceptsReturn = multiline, Height = multiline ? 110 : 0,
            ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None, AccessibleName = Describe(f),
        };
        if (f.Sensitive)
        {
            box.ReadOnly = true;
            box.Text = "Type this one on the page yourself. Blip never handles passwords, card numbers or codes.";
        }
        else
        {
            box.Text = (f.Value ?? "").Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            if (f.MaxLength is > 0) box.MaxLength = f.MaxLength.Value;
        }
        var applied = box.Text;
        binding.Commit = async () =>
        {
            if (f.Sensitive || box.Text == applied) return;
            var sending = box.Text;
            var result = await SendAsync(binding, () => _client.SetFieldTextAsync(binding.Field.Id, sending.Replace(Environment.NewLine, "\n")));
            if (result is null) return;
            applied = (result.Field.Value ?? "").Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            if (box.Text == sending) box.Text = applied;
        };
        box.Leave += (_, _) => _ = RunAsync(binding.Commit);
        Bind(binding, box);
    }

    /// <summary>
    /// Date and time fields become plain dropdowns: Month, Day, Year (and Hour, Minute). Tab moves
    /// between them; arrows or typing choose ("N" for November, "2026" for the year). Blip writes the
    /// result in the page's own format, so the user never has to know it.
    /// </summary>
    private void AddDate(Binding binding)
    {
        var f = binding.Field;
        AddLabel(binding);
        var invariant = System.Globalization.CultureInfo.InvariantCulture;
        var hasDate = f.InputType != "time";
        var hasTime = f.InputType is "time" or "datetime-local";
        // Real browser date fields always use ISO dates; a page's own date box uses its own format.
        var format = f.InputType switch
        {
            "time" => "HH:mm",
            "datetime-local" => "yyyy-MM-dd'T'HH:mm",
            _ when f.DateFormat is { } pattern => NetDateFormat(pattern),
            _ => "yyyy-MM-dd",
        };
        var parsed = DateTime.TryParseExact(f.Value ?? "", [format, "HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss"],
            invariant, System.Globalization.DateTimeStyles.None, out var current);

        var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        var parts = new List<(string Name, ComboBox Box)>();
        ComboBox Part(string name, IReadOnlyList<string> items, int selected, int width)
        {
            var box = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = width, AccessibleName = name, TabIndex = parts.Count };
            box.Items.Add("not set");
            foreach (var item in items) box.Items.Add(item);
            box.SelectedIndex = selected >= 0 ? selected + 1 : 0;
            parts.Add((name, box));
            row.Controls.Add(box);
            return box;
        }

        var thisYear = DateTime.Today.Year;
        var years = Enumerable.Range(thisYear - 100, 111).Reverse().ToList();
        if (parsed && !years.Contains(current.Year)) years.Add(current.Year);
        ComboBox? month = null, day = null, year = null, hour = null, minute = null;
        if (hasDate)
        {
            month = Part("Month", invariant.DateTimeFormat.MonthNames.Take(12).ToList(), parsed ? current.Month - 1 : -1, 150);
            day = Part("Day", Enumerable.Range(1, 31).Select(d => d.ToString(invariant)).ToList(), parsed ? current.Day - 1 : -1, 90);
            year = Part("Year", years.Select(y => y.ToString(invariant)).ToList(), parsed ? years.IndexOf(current.Year) : -1, 100);
        }
        if (hasTime)
        {
            hour = Part("Hour, 24-hour clock", Enumerable.Range(0, 24).Select(h => h.ToString("00", invariant)).ToList(), parsed ? current.Hour : -1, 90);
            minute = Part("Minute", Enumerable.Range(0, 60).Select(m => m.ToString("00", invariant)).ToList(), parsed ? current.Minute : -1, 90);
        }
        // The first dropdown carries the field's full description, so JAWS reads it on arrival.
        void Name(string description) => parts[0].Box.AccessibleName = $"{description}, {parts[0].Name}";
        Name(Describe(f));

        // Null: incomplete or impossible (like 30 February). Empty: every part "not set".
        string? Wire()
        {
            if (parts.All(p => p.Box.SelectedIndex == 0)) return "";
            if (parts.Any(p => p.Box.SelectedIndex == 0)) return null;
            var date = hasDate ? (Year: years[year!.SelectedIndex - 1], Month: month!.SelectedIndex, Day: day!.SelectedIndex) : (Year: 2000, Month: 1, Day: 1);
            if (date.Day > DateTime.DaysInMonth(date.Year, date.Month)) return null;
            var value = new DateTime(date.Year, date.Month, date.Day, hasTime ? hour!.SelectedIndex - 1 : 0, hasTime ? minute!.SelectedIndex - 1 : 0, 0);
            return value.ToString(format, invariant);
        }
        var applied = Wire() ?? "";
        binding.Commit = async () =>
        {
            var sending = Wire();
            if (sending is null)
            {
                Say($"{f.Label}: choose every part ({string.Join(", ", parts.Select(p => p.Name.Split(',')[0].ToLowerInvariant()))}), and make sure the day exists in that month.");
                return;
            }
            if (sending == applied) return;
            if (await SendAsync(binding, () => _client.SetFieldTextAsync(binding.Field.Id, sending)) is not { } result) return;
            applied = result.Field.Value ?? "";
            // A page's own calendar may reject or rewrite a date it can't read: say what it did.
            if (f.DateFormat is not null && applied != sending && result.Field.Invalid == "")
            {
                Say(applied == ""
                    ? $"{f.Label}: the page didn't keep {sending}. Its format may differ from {SpokenDateFormat(f.DateFormat)}; you can type the date on the page instead."
                    : $"{f.Label}: you sent {sending}, and the page changed it to {applied}.");
            }
        };
        // Send once focus leaves the whole date, not after each part.
        row.Leave += (_, _) => _ = RunAsync(binding.Commit);
        Add(row);
        binding.Main = parts[0].Box;
        binding.Parts.Add(row);
        binding.Parts.AddRange(parts.Select(p => (Control)p.Box));
        binding.Rename = Name;
    }

    /// <summary>"MM/DD/YYYY" becomes "month/day/year", for speech.</summary>
    private static string SpokenDateFormat(string pattern) => pattern
        .Replace("YYYY", "year").Replace("YY", "2-digit year").Replace("MM", "month").Replace("DD", "day");

    /// <summary>"MM/DD/YYYY" becomes the .NET format "MM/dd/yyyy".</summary>
    private static string NetDateFormat(string pattern) => pattern
        .Replace("YYYY", "yyyy").Replace("YY", "yy").Replace("DD", "dd").Replace("/", "'/'");

    private void AddSelect(Binding binding)
    {
        var f = binding.Field;
        AddLabel(binding);
        var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 640, AccessibleName = Describe(f) };
        foreach (var option in f.Options ?? []) combo.Items.Add(option.Label);
        combo.SelectedIndex = (f.Options ?? []).FindIndex(o => o.Selected);
        var applied = combo.SelectedIndex;
        binding.Commit = async () =>
        {
            if (combo.SelectedIndex < 0 || combo.SelectedIndex == applied) return;
            var choice = combo.SelectedIndex;
            if (await SendAsync(binding, () => _client.SetFieldOptionAsync(binding.Field.Id, choice)) is not null) applied = choice;
        };
        // Arrowing through a closed list changes the choice on every key: send it once, on leaving.
        combo.Leave += (_, _) => _ = RunAsync(binding.Commit);
        Bind(binding, combo);
    }

    private void AddCheckBox(Binding binding)
    {
        var f = binding.Field;
        var check = new CheckBox { Text = Describe(f), AutoSize = true, MaximumSize = new Size(640, 0), Checked = f.Checked == true, Margin = new Padding(3, 10, 3, 2), UseMnemonic = false };
        binding.Commit = async () =>
        {
            var wanted = check.Checked;
            var result = await SendAsync(binding, () => _client.SetFieldCheckedAsync(binding.Field.Id, wanted));
            _updating = true;
            check.Checked = result?.Field.Checked ?? !wanted;
            _updating = false;
        };
        // A check box is one decision: send it right away.
        check.CheckedChanged += (_, _) => { if (!_updating) _ = RunAsync(binding.Commit); };
        Add(check);
        Bind(binding, check);
    }

    private void AddRadio(Binding binding)
    {
        var f = binding.Field;
        var group = new GroupBox { Text = Describe(f), AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(640, 0), Margin = new Padding(3, 10, 3, 2) };
        var inner = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Fill };
        var radios = new List<RadioButton>();
        foreach (var option in f.Options ?? [])
        {
            var radio = new RadioButton { Text = option.Label, AutoSize = true, Checked = option.Selected, UseMnemonic = false };
            radios.Add(radio);
            inner.Controls.Add(radio);
        }
        group.Controls.Add(inner);
        var applied = radios.FindIndex(r => r.Checked);
        binding.Commit = async () =>
        {
            var choice = radios.FindIndex(r => r.Checked);
            if (choice < 0 || choice == applied) return;
            if (await SendAsync(binding, () => _client.SetFieldOptionAsync(binding.Field.Id, choice)) is not null) applied = choice;
        };
        group.Leave += (_, _) => _ = RunAsync(binding.Commit);
        Add(group);
        binding.Main = radios.FirstOrDefault(r => r.Checked) ?? (Control?)radios.FirstOrDefault() ?? group;
        binding.Parts.AddRange([group, .. radios]);
        binding.Label = null;
    }

    private void AddCombo(Binding binding)
    {
        var f = binding.Field;
        AddLabel(binding);
        var typing = TypingTypes.Contains(f.InputType);
        var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        var box = new TextBox
        {
            Width = 440, Text = f.Value ?? "", ReadOnly = !typing,
            AccessibleName = Describe(f) + (typing ? ". Type to filter, then Down Arrow for choices" : ". Down Arrow for choices"),
        };
        var choose = new Button { Text = "Choose from list…", AutoSize = true, AccessibleName = $"Choose {f.Label} from a list" };
        row.Controls.Add(box);
        row.Controls.Add(choose);
        box.TabIndex = 0;
        choose.TabIndex = 1;
        var applied = box.Text;

        async Task ChooseAsync()
        {
            var filter = typing && box.Text != applied ? box.Text : "";
            FieldOptionsResult options;
            try { options = await _client.GetFieldOptionsAsync(binding.Field.Id, filter); }
            catch (DeskException ex) { Say(ex.Message); return; }
            if (options.Options.Count == 0)
            {
                Say(typing ? "No choices appeared. Type a few letters in the box first, then choose again." : "No choices appeared on the page for this field.");
                box.Focus();
                return;
            }
            var pick = ChoiceDialog.Pick(this, f.Label, options.Options, options.Truncated);
            if (pick < 0) { box.Focus(); return; }
            var result = await SendAsync(binding, () => _client.SetFieldOptionAsync(binding.Field.Id, pick));
            if (result is not null) { applied = result.Field.Value ?? ""; box.Text = applied; }
            box.Focus();
        }

        binding.Commit = async () =>
        {
            if (!typing || box.Text == applied) return;
            var sending = box.Text;
            var result = await SendAsync(binding, () => _client.SetFieldTextAsync(binding.Field.Id, sending));
            if (result is not null) { applied = result.Field.Value ?? ""; if (box.Text == sending) box.Text = applied; }
        };
        choose.Click += async (_, _) => await RunAsync(ChooseAsync);
        // Type to filter, then Down Arrow: the page's matching choices open in a list, focus inside it.
        box.KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.Down) { e.Handled = e.SuppressKeyPress = true; await RunAsync(ChooseAsync); }
        };
        // Moving from the box to its own Choose button is part of choosing, not a finished entry.
        box.Leave += (_, _) => BeginInvoke(() => { if (!choose.Focused) _ = RunAsync(binding.Commit); });
        Add(row);
        binding.Main = box;
        binding.Parts.AddRange([box, choose, row]);
    }

    private void AddOther(Binding binding)
    {
        var f = binding.Field;
        AddLabel(binding);
        var box = new TextBox
        {
            Width = 640, ReadOnly = true, AccessibleName = Describe(f),
            Text = f.Hint != "" ? f.Hint : "Blip can't fill this kind of field yet. Do this one on the page.",
        };
        Bind(binding, box);
    }

    private void Bind(Binding binding, Control main)
    {
        if (main.Parent is null) Add(main);
        binding.Main = main;
        binding.Parts.Add(main);
    }

    // ---------------------------------------------------------------- sending changes

    /// <summary>Sends one change, then re-reads the form so ids, errors and any new fields stay current.</summary>
    private async Task<SetFieldResult?> SendAsync(Binding binding, Func<Task<SetFieldResult>> send)
    {
        SetFieldResult result;
        try { result = await send(); }
        catch (DeskException ex)
        {
            Say($"{binding.Field.Label}: {ex.Message}");
            return null;
        }
        binding.Field = result.Field;
        Relabel(binding);
        if (result.Field.Invalid != "") Say($"{result.Field.Label}: {result.Field.Invalid}");
        else if (result.Detail != "") Say($"{result.Field.Label}: {result.Detail}");
        await RefreshAfterChangeAsync();
        return result;
    }

    /// <summary>
    /// The page may react to a change: show a new field, mark another invalid. Re-read the form;
    /// if the same fields are there, just adopt their fresh ids and messages, otherwise rebuild.
    /// </summary>
    private async Task RefreshAfterChangeAsync()
    {
        FieldsResult fresh;
        try { fresh = await _client.GetFieldsAsync(_regionId); }
        catch (DeskException) { return; }
        var same = fresh.Fields.Count == _bindings.Count &&
            fresh.Fields.Select((f, i) => $"{f.Kind}|{f.Label}" == _bindings[i].Key).All(match => match);
        if (same)
        {
            for (var i = 0; i < _bindings.Count; i++)
            {
                _bindings[i].Field = fresh.Fields[i];
                Relabel(_bindings[i]);
            }
            return;
        }
        var focus = FocusedKey();
        var before = _bindings.Count;
        Build(fresh);
        (_bindings.FirstOrDefault(b => b.Key == focus)?.Main ?? _summary).Focus();
        var change = fresh.Fields.Count - before;
        Say(change > 0 ? $"The form added {Count(change, "field")}." : change < 0 ? $"The form removed {Count(-change, "field")}." : "The form changed its fields.");
    }

    private void Relabel(Binding binding)
    {
        var text = Describe(binding.Field);
        if (binding.Label is not null) binding.Label.Text = text;
        switch (binding.Parts.FirstOrDefault())
        {
            case GroupBox group: group.Text = text; break;
            case CheckBox check: check.Text = text; break;
        }
        if (binding.Rename is not null) binding.Rename(text);
        else if (binding.Main is TextBox or ComboBox) binding.Main.AccessibleName = text;
    }

    private string? FocusedKey()
    {
        var focused = ActiveControl;
        while (focused is ContainerControl { ActiveControl: { } inner }) focused = inner;
        return _bindings.FirstOrDefault(b => b.Parts.Any(p => p == focused || p.ContainsFocus))?.Key;
    }

    private void Say(string message) =>
        MessageBox.Show(this, message, "Blip Desk form", MessageBoxButtons.OK, MessageBoxIcon.Information);

    // ---------------------------------------------------------------- buttons and closing

    private async Task PressAsync(DeskControl control)
    {
        // Let any change still on its way reach the page first.
        await RunAsync(() => Task.CompletedTask);
        if (control.Access == "blocked")
        {
            Say($"{control.Label} is not allowed: {control.Note}.");
            return;
        }
        if (control.Access == "confirm")
        {
            var answer = MessageBox.Show(this,
                $"Press \"{control.Label}\"? It {control.Note}.{Environment.NewLine}{Environment.NewLine}The form on the page now says:{Environment.NewLine}{ReadBack()}",
                "Blip Desk: confirm", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            Confirmed = true;
        }
        Chosen = control;
        _closingChecked = true;
        DialogResult = DialogResult.OK;
        Close();
    }

    /// <summary>Every field as the page reported it after the last change.</summary>
    private string ReadBack()
    {
        var lines = _bindings.Take(25).Select(b =>
        {
            var f = b.Field;
            var value = f.Sensitive ? "(on the page only)"
                : f.Kind == "checkbox" ? (f.Checked == true ? "checked" : "not checked")
                : string.IsNullOrWhiteSpace(f.Value) ? (f.Kind is "select" or "radio" or "combobox" ? "(nothing chosen)" : "(empty)")
                : f.Value.Length > 120 ? f.Value[..120] + "…" : f.Value;
            return $"{f.Label}: {value}" + (f.Invalid != "" ? $" (error: {f.Invalid})" : "");
        }).ToList();
        if (_bindings.Count > 25) lines.Add($"…and {_bindings.Count - 25} more fields.");
        return lines.Count > 0 ? string.Join(Environment.NewLine, lines) : "(no fields)";
    }

    protected override async void OnFormClosing(FormClosingEventArgs e)
    {
        if (_closingChecked) { base.OnFormClosing(e); return; }
        // A change typed into the focused field hasn't been sent yet: send it, then close.
        var pending = _bindings.FirstOrDefault(b => b.Key == FocusedKey());
        e.Cancel = true;
        _closingChecked = true;
        if (pending is not null && pending.Field.Kind is "text" or "textarea" or "select" or "radio" or "combobox")
        {
            await RunAsync(pending.Commit);
        }
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _gate.Dispose();
        base.Dispose(disposing);
    }
}

/// <summary>A plain list of a field's choices: arrows and first letters move, Enter picks, Escape cancels.</summary>
public sealed class ChoiceDialog : Form
{
    private readonly ListBox _list = new() { Dock = DockStyle.Fill, IntegralHeight = false };

    private ChoiceDialog(string label, List<FieldOption> options, bool truncated)
    {
        Text = $"Choose {label}";
        Width = 520;
        Height = 480;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        _list.AccessibleName = $"{label}: {options.Count} choices" + (truncated ? ", more not shown" : "");
        foreach (var option in options) _list.Items.Add(option.Label);
        var selected = options.FindIndex(o => o.Selected);
        _list.SelectedIndex = selected >= 0 ? selected : 0;
        var ok = new Button { Text = "Choose", DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        Controls.Add(_list);
        Controls.Add(buttons);
        AcceptButton = ok;
        CancelButton = cancel;
        _list.DoubleClick += (_, _) => { DialogResult = DialogResult.OK; Close(); };
        Shown += (_, _) => _list.Focus();
    }

    /// <summary>Returns the chosen index, or -1 when cancelled.</summary>
    public static int Pick(IWin32Window owner, string label, List<FieldOption> options, bool truncated)
    {
        using var dialog = new ChoiceDialog(label, options, truncated);
        return dialog.ShowDialog(owner) == DialogResult.OK ? dialog._list.SelectedIndex : -1;
    }
}
