namespace BlipDesk;

// Keyboard map (F1 shows it):
//   F5            get the outline of the current Chrome tab
//   Enter         on a part or list item: its choices (read text, links, buttons); on a list: its items;
//                 on "Read all text": read it into Content; on a link or button: use it
//   Control+Enter on a list item: open its main link straight away
//   Escape        go back one level (from Content, back to the list)
//   Control+H     show or hide the hidden parts (ads, cookie banners, off-screen frames)
//   Alt+G / Alt+P / Alt+C   jump to Goal, Page, Content
public sealed class MainForm : Form
{
    /// <summary>One level of the Page list: what it shows and how to rebuild it.</summary>
    private sealed record View(string Title, Func<List<PageEntry>> Build, string? ReturnToId = null);

    private readonly DeskClient _client = new();
    private readonly TextBox _goal = new() { Dock = DockStyle.Fill, AccessibleName = "Goal" };
    private readonly ListBox _page = new() { Dock = DockStyle.Fill, IntegralHeight = false, AccessibleName = "Page" };
    private readonly TextBox _content = new()
    {
        Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
        WordWrap = true, AccessibleName = "Content", BackColor = SystemColors.Window,
    };
    private readonly ToolStripStatusLabel _status = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };

    private readonly Stack<View> _views = new();
    private PageOutline? _outline;
    private bool _showHidden;
    private bool _busy;

    public MainForm()
    {
        Text = "Blip Desk";
        Width = 900;
        Height = 700;
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(8) };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 55));

        // Each label sits directly before its control in tab order, so screen readers use it as the name.
        layout.Controls.Add(new Label { Text = "&Goal (what you're trying to do, optional)", AutoSize = true, TabIndex = 0 });
        _goal.TabIndex = 1;
        layout.Controls.Add(_goal);
        layout.Controls.Add(new Label { Text = "&Page", AutoSize = true, TabIndex = 2, Margin = new Padding(3, 10, 3, 3) });
        _page.TabIndex = 3;
        layout.Controls.Add(_page);
        layout.Controls.Add(new Label { Text = "&Content", AutoSize = true, TabIndex = 4, Margin = new Padding(3, 10, 3, 3) });
        _content.TabIndex = 5;
        layout.Controls.Add(_content);

        var statusStrip = new StatusStrip();
        statusStrip.Items.Add(_status);
        Controls.Add(layout);
        Controls.Add(statusStrip);

        _page.KeyDown += OnPageKeyDown;
        _page.DoubleClick += async (_, _) => await OpenSelectedAsync(direct: false);
        _content.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape) { e.Handled = e.SuppressKeyPress = true; _page.Focus(); }
        };

        ShowMessage("Press F5 to get the outline of your current Chrome tab. F1 lists the keys.");
        Shown += (_, _) => _page.Focus();
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.F5:
                _ = RefreshOutlineAsync(announce: null);
                return true;
            case Keys.Control | Keys.H:
                ToggleHidden();
                return true;
            case Keys.F1:
                ShowHelp();
                return true;
            case Keys.Alt | Keys.Left:
                _ = BackPageAsync();
                return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private async void OnPageKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter)
        {
            e.Handled = e.SuppressKeyPress = true;
            await OpenSelectedAsync(direct: e.Control);
        }
        else if ((e.KeyCode == Keys.Escape || e.KeyCode == Keys.Back) && _views.Count > 1)
        {
            e.Handled = e.SuppressKeyPress = true;
            GoBack();
        }
        else if (e.KeyCode == Keys.Escape || e.KeyCode == Keys.Back)
        {
            // At the top level there is no level to leave: go back to the previous page instead.
            e.Handled = e.SuppressKeyPress = true;
            await BackPageAsync();
        }
    }

    // ---------------------------------------------------------------- outline

    /// <summary>Gets a fresh outline and shows it as the top level.</summary>
    private async Task RefreshOutlineAsync(string? announce)
    {
        if (_busy) return;
        _busy = true;
        SetStatus("Getting the page outline…");
        try
        {
            _outline = await _client.GetOutlineAsync();
            ResetToOutline();
            Text = $"Blip Desk - {_outline.Title}";
            if (announce is not null) SetStatus($"{announce} {Summary()}"); else SetStatus(Summary());
        }
        catch (DeskException ex) { ShowMessage(ex.Message); }
        finally { _busy = false; }
    }

    private void ResetToOutline()
    {
        _views.Clear();
        _views.Push(new View("Page", () => _outline is null ? [] : PageView.Build(_outline, _showHidden)));
        ShowCurrent(selectId: null);
    }

    private string Summary() => _page.Items.Count > 0 ? ((PageEntry)_page.Items[0]).Text : "";

    // ---------------------------------------------------------------- navigation between levels

    private void Push(View view)
    {
        _views.Push(view);
        ShowCurrent(selectId: null);
        SetStatus(Summary());
    }

    private void GoBack()
    {
        var leaving = _views.Pop();
        ShowCurrent(selectId: leaving.ReturnToId);
        SetStatus($"Back to {_views.Peek().Title}.");
    }

    private void ShowCurrent(string? selectId)
    {
        if (_views.Count == 0) return;
        var entries = _views.Peek().Build();
        _page.BeginUpdate();
        _page.Items.Clear();
        foreach (var entry in entries) _page.Items.Add(entry);
        _page.EndUpdate();
        var index = selectId is null ? 0 : Math.Max(0, entries.FindIndex(e => e.Id == selectId));
        if (_page.Items.Count > 0) _page.SelectedIndex = index;
        _page.Focus();
    }

    // ---------------------------------------------------------------- Enter

    private async Task OpenSelectedAsync(bool direct)
    {
        if (_busy || _page.SelectedItem is not PageEntry entry) return;
        switch (entry.Kind)
        {
            case EntryKind.Region when entry.IsList && entry.Region is not null:
                var list = entry.Region;
                Push(new View(PageView.Name(list), () => PageView.BuildItems(list), ReturnToId: list.Id));
                break;
            case EntryKind.Region when entry.Id is not null:
                await OpenChoicesAsync(entry.Id, entry.Region is null ? entry.Text : PageView.Name(entry.Region), direct: false);
                break;
            case EntryKind.Item when entry.Id is not null:
                await OpenChoicesAsync(entry.Id, ItemTitle(entry.Text), direct);
                break;
            case EntryKind.ReadAll when entry.Id is not null:
                await ReadAsync(entry.Id);
                break;
            case EntryKind.Control when entry.Control is not null:
                await ActivateAsync(entry.Control);
                break;
        }
    }

    private static string ItemTitle(string text)
    {
        var stop = text.IndexOf(". ", StringComparison.Ordinal);
        return stop > 0 ? text[..stop] : text;
    }

    /// <summary>Shows "Read all text" plus the links and buttons in one part; Control+Enter on an item opens its main link.</summary>
    private async Task OpenChoicesAsync(string regionId, string title, bool direct)
    {
        _busy = true;
        SetStatus("Finding links and buttons…");
        RegionControls controls;
        try { controls = await _client.GetControlsAsync(regionId); }
        catch (DeskException ex) { _busy = false; SetStatus(ex.Message); return; }
        _busy = false;

        if (direct)
        {
            var main = controls.Controls.FirstOrDefault(c => c.Kind == "link" && c.Access != "blocked");
            if (main is not null) { await ActivateAsync(main); return; }
            SetStatus("This item has no link to open. Showing its choices.");
        }
        if (controls.Controls.Count == 0 && !direct)
        {
            // Nothing to choose: just read it.
            await ReadAsync(regionId);
            return;
        }
        var returnTo = regionId;
        Push(new View(title, () => PageView.BuildControls(title, regionId, controls), ReturnToId: returnTo));
    }

    private async Task ReadAsync(string regionId)
    {
        _busy = true;
        SetStatus("Reading…");
        try
        {
            var region = await _client.ReadRegionAsync(regionId);
            var text = region.Text.Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            if (region.Truncated) text += Environment.NewLine + "(Cut off here: this part is very long.)";
            _content.Text = text.Length > 0 ? text : "This part has no readable text.";
            _content.SelectionStart = 0;
            _content.SelectionLength = 0;
            SetStatus($"{region.Label}. Escape goes back to the list.");
            _content.Focus();
        }
        catch (DeskException ex) { SetStatus(ex.Message); }
        finally { _busy = false; }
    }

    private async Task ActivateAsync(DeskControl control)
    {
        if (control.Access == "blocked")
        {
            SetStatus($"{control.Label} is not allowed: {control.Note}.");
            return;
        }
        var confirmed = false;
        if (control.Access == "confirm")
        {
            var what = control.Kind == "link" ? $"Open the link \"{control.Label}\"?" : $"Press the button \"{control.Label}\"?";
            var answer = MessageBox.Show(this, $"{what} It {control.Note}.", "Blip Desk: confirm",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) { SetStatus("Cancelled."); _page.Focus(); return; }
            confirmed = true;
        }

        var oldUrl = _outline?.PageUrl;
        _busy = true;
        SetStatus(control.Kind == "link" ? $"Opening {control.Label}…" : $"Pressing {control.Label}…");
        try
        {
            var result = await _client.ActivateAsync(control.Id, confirmed);
            _busy = false;
            if (result.Kind == "link") await WaitForNewPageAsync(oldUrl, control.Label);
            else
            {
                await Task.Delay(900);
                await RefreshOutlineAsync(announce: $"Pressed {control.Label}.");
            }
        }
        catch (DeskException ex) { _busy = false; SetStatus(ex.Message); }
    }

    /// <summary>After following a link, poll until the tab shows a different page, then outline it.</summary>
    private async Task WaitForNewPageAsync(string? oldUrl, string label)
    {
        ShowMessage($"Opening {label}…");
        for (var attempt = 0; attempt < 14; attempt++)
        {
            await Task.Delay(attempt == 0 ? 1200 : 700);
            try
            {
                var outline = await _client.GetOutlineAsync();
                if (outline.PageUrl != oldUrl && outline.Regions.Count > 0)
                {
                    _outline = outline;
                    ResetToOutline();
                    Text = $"Blip Desk - {outline.Title}";
                    SetStatus($"Opened. {Summary()}");
                    return;
                }
            }
            catch (DeskException) { /* page still loading: try again */ }
        }
        ShowMessage("The new page is taking a while. Press F5 when it has loaded.");
    }

    private async Task BackPageAsync()
    {
        if (_busy) return;
        var oldUrl = _outline?.PageUrl;
        _busy = true;
        try
        {
            var back = await _client.BackAsync();
            _busy = false;
            var name = string.IsNullOrWhiteSpace(back.Title) ? "the previous page" : back.Title;
            await WaitForNewPageAsync(oldUrl, $"back to {name}");
        }
        catch (DeskException ex) { _busy = false; SetStatus(ex.Message); }
    }

    // ---------------------------------------------------------------- other keys

    private void ToggleHidden()
    {
        _showHidden = !_showHidden;
        if (_outline is not null && _views.Count == 1)
        {
            var current = (_page.SelectedItem as PageEntry)?.Id;
            ShowCurrent(current);
            _page.SelectedIndex = 0;
        }
        SetStatus(_showHidden ? "Showing hidden parts." : "Hiding ads and other hidden parts.");
    }

    private void ShowMessage(string message)
    {
        _views.Clear();
        _views.Push(new View("Page", () => [new PageEntry(message, EntryKind.Summary)]));
        ShowCurrent(selectId: null);
        SetStatus(message);
    }

    private void SetStatus(string text) => _status.Text = text;

    private void ShowHelp()
    {
        _content.Text = string.Join(Environment.NewLine,
            "Blip Desk keys:",
            "F5: get the outline of your current Chrome tab.",
            "Enter on a part or a list item: its choices. Read all text, then its links and buttons.",
            "Enter on a list: its items.",
            "Enter on a link or button: use it. Some ask you first. Pay, delete and send buttons are not allowed yet.",
            "Control Enter on a list item: open its main link straight away.",
            "Escape: go back one level. From here, back to the Page list.",
            "Escape or Backspace at the top of the Page list, or Alt Left Arrow anywhere: back to the previous page.",
            "Control H: show or hide the hidden parts, such as ads and cookie banners.",
            "Alt G, Alt P, Alt C: jump to Goal, Page, or Content.",
            "The first line of every list says where you are.");
        _content.SelectionStart = 0;
        _content.Focus();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _client.Dispose();
        base.Dispose(disposing);
    }
}
