# Textual TUI — Deep dive for Git Happens

This doc summarizes the [Textual](https://textual.textualize.io/) framework and how it maps to the AI PR review CLI (list PRs → pick one → run AI → submit review).

---

## What is Textual?

- **Python TUI framework** from Textualize (same team as [Rich](https://rich.readthedocs.io/)).
- Build terminal UIs with **widgets**, **CSS-like styling**, **screens**, and **async**.
- Runs in the terminal (and can run in the browser with Textual Web).
- **Requirements:** Python 3.9+.
- **Install:** `pip install textual` (dev: `pip install textual-dev`, syntax: `pip install "textual[syntax]"`).

**Docs:** [textual.textualize.io](https://textual.textualize.io/) — Guide, Reference, Getting started.

---

## Concepts that map to our app

### 1. App and compose

- Subclass `App`, implement `compose()` to yield widgets.
- One “default” screen is implicit; you can add more screens via `SCREENS` or `push_screen()`.

```python
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, DataTable

class PRListApp(App):
    def compose(self) -> ComposeResult:
        yield Header()
        yield DataTable()   # PR list
        yield Footer()
```

### 2. DataTable — PR list

- **DataTable** is ideal for “list of PRs” with columns: number, title, author, repo, etc.
- `add_columns("col1", "col2", ...)` then `add_rows([(...), ...])` or `add_row(...)`.
- Use **row keys** (e.g. PR number or `owner/repo#num`) so you can reference the selected row after the user presses Enter.
- **Cursor:** set `cursor_type = "row"` so Enter selects a whole row (not a single cell).
- **Events:** handle `DataTable.RowSelected` (or `CellSelected` if cursor is cell) to get the selected row key / data and then push the “review” flow.

```python
def on_mount(self) -> None:
    table = self.query_one(DataTable)
    table.cursor_type = "row"
    table.add_columns("PR", "Title", "Author", "Repo")
    # key could be "owner/repo#123" for later use
    table.add_row("123", "Fix login", "alice", "acme/api", key="acme/api#123")

def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
    pr_key = event.row_key  # use to fetch diff, run AI, etc.
    self.push_screen(ReviewScreen(pr_key))
```

### 3. ListView — Alternative to DataTable

- **ListView** = vertical list of `ListItem(Label("..."))`.
- Good for a simple “pick one” list (e.g. PR titles only). For “PR #, title, author, repo” a **DataTable** is usually better.

```python
yield ListView(
    ListItem(Label("#123 Fix login (alice)")),
    ListItem(Label("#124 Add tests (bob)")),
)
# on_list_view_selected gives you the selected ListItem / index
```

### 4. Screens — List vs review vs confirm

- **Screens** = full-terminal containers. Only one is active at a time.
- **Stack:** `push_screen(screen)` pushes, `pop_screen()` pops. Use for: **PR list (main)** → **Review in progress** (or diff view) → **Confirm submit** (modal).
- Register screens by name: `SCREENS = {"review": ReviewScreen}` then `push_screen("review", pr_key)` or pass an instance.

**Flow for our app:**

1. **Main screen:** DataTable of PRs (+ optional filter tabs or inputs). Enter on row → push “review” screen with that PR.
2. **Review screen:** Shows “Loading diff…”, then “Running AI…”, then the review body + list of inline comments. Buttons or keys: “Submit”, “Edit”, “Cancel”.
3. **Confirm modal:** “Submit this review? (approve / request changes / comment)” → Yes → call `gh api` and pop back; No → pop back to review screen.

### 5. ModalScreen — Confirm dialogs

- **ModalScreen** dims the previous screen and blocks its bindings. Use for “Submit review?”.
- **Returning a value:** use `dismiss_with_result(value)` (or the screen result system). The caller can `await push_screen(ConfirmScreen())` and get the result when the screen is dismissed.
- **Callback pattern:** alternatively pass a callback when pushing the screen and call it with the result before popping.

```python
class ConfirmSubmitScreen(ModalScreen):
    def compose(self) -> ComposeResult:
        yield Button("Submit", id="yes")
        yield Button("Cancel", id="no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "yes":
            self.dismiss_with_result(True)
        else:
            self.dismiss_with_result(False)
```

### 6. Workers — Don’t block the UI

- **Problem:** Calling `gh pr diff` or the AI CLI can take seconds. If you do it in a message handler, the UI freezes.
- **Solution:** run that work in a **worker** via `run_worker(coro)` or the `@work` decorator. Workers run concurrently; the UI stays responsive.
- Use `exclusive=True` if you only want one such job at a time (e.g. “run AI” so the user can’t trigger it twice).

```python
from textual import work

class ReviewScreen(Screen):
    @work(exclusive=True)
    async def run_ai_review(self, diff: str, pr_meta: dict) -> None:
        # Run gh + AI CLI in background; post message when done
        result = await self.run_ai(diff, pr_meta)
        self.post_message(ReviewDone(result))  # custom message

    def on_mount(self) -> None:
        self.run_ai_review(self.diff_text, self.pr_meta)
```

- When the worker finishes, have it **post a message** (e.g. `ReviewDone(review_json)`). The screen handles that message and updates the UI (show review, enable “Submit”, etc.).

### 7. Subprocess / async

- Use **asyncio** for I/O: `asyncio.create_subprocess_exec` (or `subprocess.run` in a thread/worker) to run `gh` and the AI CLI.
- **Textual is async-friendly:** app runs in an event loop; workers are async. So you can `await` inside a worker and then update widgets from the main thread by posting messages.

### 8. Styling (CSS)

- Textual uses **CSS-like styles**: `.tcss` files or `CSS = "..."` on the class.
- You can style DataTable, Buttons, Headers, and your own widget IDs/classes. Good for making the PR list readable and the “Submit” action obvious.

### 9. Rich integration

- **Rich** renderables (e.g. `Rich Text`, `Panel`, `Table`) can be shown in a `Static` widget. Useful for displaying the **review body** (markdown) or the **diff** in a scrollable area before/after AI runs.
- Optional: `pip install "textual[syntax]"` for syntax-highlighted code in the diff.

---

## Suggested structure for Git Happens

| Piece              | Textual piece |
|--------------------|----------------|
| List PRs           | DataTable (cursor_type="row"), populated in `on_mount` via worker that runs `gh pr list` / `gh search prs` |
| Select PR          | `on_data_table_row_selected` → push_screen(ReviewScreen(pr_key)) |
| Fetch diff         | Worker: run `gh pr diff <num>`, post message with diff text |
| Run AI             | Worker: build prompt, call AI CLI (subprocess), parse JSON, post ReviewDone |
| Show review        | Static (Rich Markdown) + list of inline comments; Buttons: Submit / Edit / Cancel |
| Confirm submit     | ModalScreen with “Submit?” Yes/No; on Yes → `gh api` in worker, then pop_screen |
| Errors / loading   | Status bar or a dedicated Static; update from workers via messages |

---

## Quick reference

- **DataTable row selection:** `cursor_type = "row"`, handle `DataTable.RowSelected`, use `event.row_key`.
- **Screens:** `push_screen(name_or_instance)`, `pop_screen()`, `dismiss_with_result(value)` on modals.
- **Background work:** `@work` or `run_worker(async_fn(...), exclusive=True)`, then `post_message(CustomMsg(data))` to update UI.
- **Docs:** [Guide](https://textual.textualize.io/guide/), [Widgets (DataTable, ListView)](https://textual.textualize.io/widgets/), [Workers](https://textual.textualize.io/guide/workers/), [Screens](https://textual.textualize.io/guide/screens/).

---

## Run the demo

After `pip install textual`:

```bash
python -m textual
```

Then explore the examples in the Textual repo (`examples/` directory) for DataTable, screens, and workers.
