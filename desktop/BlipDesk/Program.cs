namespace BlipDesk;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // Test mode: BlipDesk.exe --dump <file> writes the Page list for the current tab and exits.
        if (args.Length == 2 && args[0] == "--dump") return DumpAsync(args[1]).GetAwaiter().GetResult();
        // Test mode: BlipDesk.exe --fields <file> writes every form field on the current tab and exits.
        if (args.Length == 2 && args[0] == "--fields") return DumpFieldsAsync(args[1]).GetAwaiter().GetResult();
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }

    private static async Task<int> DumpFieldsAsync(string path)
    {
        using var client = new DeskClient();
        try
        {
            var outline = await client.GetOutlineAsync();
            var result = await client.GetFieldsAsync(null);
            var lines = new List<string> { $"URL: {outline.PageUrl}" };
            foreach (var f in result.Fields)
            {
                var extra = f.Options is { Count: > 0 } ? $" [{string.Join(" | ", f.Options.Take(8).Select(o => (o.Selected ? "*" : "") + o.Label))}{(f.Options.Count > 8 ? " …" : "")}]" : "";
                lines.Add($"{f.Id} {f.Kind}/{f.InputType} \"{f.Label}\" = {(f.Sensitive ? "(sensitive)" : f.Kind == "checkbox" ? f.Checked.ToString() : f.Value)}{(f.Required ? " required" : "")}{(f.Invalid != "" ? $" ERROR {f.Invalid}" : "")}{extra}");
            }
            foreach (var c in result.Controls) lines.Add($"button {c.Id} \"{c.Label}\" {c.Access} {c.Note}");
            await File.WriteAllLinesAsync(path, lines);
            return 0;
        }
        catch (DeskException ex)
        {
            await File.WriteAllTextAsync(path, "ERROR: " + ex.Message);
            return 1;
        }
    }

    private static async Task<int> DumpAsync(string path)
    {
        using var client = new DeskClient();
        try
        {
            var outline = await client.GetOutlineAsync();
            (DeskControl? Next, DeskControl? Previous) steps = default;
            if (PageView.Pager(outline) is { } pager) steps = PageView.FindPageSteps(outline, await client.GetControlsAsync(pager.Id));
            var entries = PageView.Build(outline, showHidden: false, steps);
            var lines = new List<string> { $"URL: {outline.PageUrl}" };
            lines.AddRange(entries.Select(e => (e.IsResults ? "> " : "  ") + e.Text));
            await File.WriteAllLinesAsync(path, lines);
            return 0;
        }
        catch (DeskException ex)
        {
            await File.WriteAllTextAsync(path, "ERROR: " + ex.Message);
            return 1;
        }
    }
}
