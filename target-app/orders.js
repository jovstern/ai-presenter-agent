// The Orders page: a table of 60 orders, each with a checkbox and a Ship
// button, and a New order form (issue #22: a page dense enough to reach the
// bridge's snapshot cap). The rows are static markup in orders.html, so
// nothing this deferred script does moves the layout (M9 fix wave, F1); it
// only wires up the controls. A file rather than an inline <script>: the
// server's CSP is script-src 'self' (server/app.js).
(function () {
  const FIRST_ORDER = 1001;

  const body = document.getElementById('orders-body');
  const tableScroll = document.querySelector('.table-scroll');
  const selectedCount = document.querySelector('[data-testid="orders-selected-count"]');
  const shipSelected = document.querySelector('[data-testid="ship-selected"]');
  const form = document.getElementById('new-order-form');
  const confirmation = document.querySelector('[data-testid="order-confirmation"]');
  if (!body || !selectedCount || !(shipSelected instanceof HTMLButtonElement)) return;

  /**
   * @param {HTMLTableRowElement} row
   * @param {boolean} shipped
   */
  function setShipped(row, shipped) {
    const number = row.dataset.number;
    const select = row.querySelector('input');
    const ship = row.querySelector('button');
    const status = row.querySelector('.status');
    if (!select || !ship || !status) return;
    status.textContent = shipped ? 'Shipped' : 'Pending';
    ship.textContent = shipped ? 'Shipped' : 'Ship';
    // The visible text leads the name (WCAG 2.5.3), and the order number
    // tells the 60 buttons apart.
    ship.setAttribute('aria-label', shipped ? `Shipped, order ${number}` : `Ship order ${number}`);
    ship.disabled = shipped;
    if (shipped) select.checked = false;
    select.disabled = shipped;
  }

  function ticked() {
    return [...body.querySelectorAll('input[type="checkbox"]:checked')];
  }

  function updateSelection() {
    const count = ticked().length;
    selectedCount.textContent = `${count} selected`;
    shipSelected.disabled = count === 0;
  }

  body.addEventListener('change', updateSelection);
  body.addEventListener('click', (event) => {
    const ship = event.target instanceof Element ? event.target.closest('button') : null;
    const row = ship?.closest('tr');
    if (!row) return;
    setShipped(row, true);
    updateSelection();
  });
  shipSelected.addEventListener('click', () => {
    ticked().forEach((select) => {
      const row = select.closest('tr');
      if (row) setShipped(row, true);
    });
    updateSelection();
  });

  // On a narrow screen the table scrolls sideways, and its last column (Ship)
  // starts out of view: a fade on the right edge says there is more, until
  // the table is scrolled to its end (style.css). An overlay, so it moves
  // nothing whenever it comes or goes.
  if (tableScroll instanceof HTMLElement) {
    const showMore = () => {
      const rest = tableScroll.scrollWidth - tableScroll.clientWidth - tableScroll.scrollLeft;
      tableScroll.classList.toggle('table-scroll--more', rest > 1);
    };
    tableScroll.addEventListener('scroll', showMore, { passive: true });
    new ResizeObserver(showMore).observe(tableScroll);
  }

  let nextOrder = FIRST_ORDER + body.querySelectorAll('tr').length;
  if (!(form instanceof HTMLFormElement)) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const customer = new FormData(form).get('customer');
    if (confirmation) confirmation.textContent = `Order ${nextOrder} created for ${customer}.`;
    nextOrder += 1;
  });
})();
