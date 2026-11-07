// The Orders page: a table of 60 orders, each with a checkbox and a Ship
// button, and a New order form (issue #22: a page dense enough to reach the
// bridge's snapshot cap). A file rather than an inline <script>: the server's
// CSP is script-src 'self' (server/app.js).
(function () {
  const ORDER_COUNT = 60;
  const FIRST_ORDER = 1001;
  const CUSTOMERS = [
    'Acme',
    'Globex',
    'Initech',
    'Umbrella',
    'Hooli',
    'Stark',
    'Wayne',
    'Wonka',
    'Tyrell',
    'Cyberdyne',
    'Soylent',
    'Vandelay',
  ];
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  const body = document.getElementById('orders-body');
  const selectedCount = document.querySelector('[data-testid="orders-selected-count"]');
  const shipSelected = document.querySelector('[data-testid="ship-selected"]');
  const form = document.getElementById('new-order-form');
  const confirmation = document.querySelector('[data-testid="order-confirmation"]');
  if (!body || !selectedCount || !(shipSelected instanceof HTMLButtonElement)) return;

  /**
   * One row; the same data on every load, so a test can name an order.
   * @param {number} number
   * @param {number} index
   */
  function orderRow(number, index) {
    const customer = CUSTOMERS[index % CUSTOMERS.length];
    const total = money.format(((number * 37) % 400) + 19.99);
    const shipped = index % 7 === 6;

    const row = document.createElement('tr');
    const select = document.createElement('input');
    select.type = 'checkbox';
    select.dataset.testid = `order-${number}-select`;
    select.setAttribute('aria-label', `Select order ${number}, ${customer}`);
    const ship = document.createElement('button');
    ship.type = 'button';
    ship.dataset.testid = `order-${number}-ship`;

    const cells = [select, String(number), customer, total, '', ship];
    cells.forEach((content, column) => {
      const cell = document.createElement(column === 1 ? 'th' : 'td');
      if (column === 1) cell.scope = 'row';
      if (column === 3) cell.className = 'numeric';
      if (column === 4) cell.className = 'status';
      cell.append(content);
      row.append(cell);
    });
    row.dataset.number = String(number);
    setShipped(row, shipped);
    return row;
  }

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

  body.append(
    ...Array.from({ length: ORDER_COUNT }, (_, index) => orderRow(FIRST_ORDER + index, index)),
  );

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

  let nextOrder = FIRST_ORDER + ORDER_COUNT;
  if (!(form instanceof HTMLFormElement)) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const customer = new FormData(form).get('customer');
    if (confirmation) confirmation.textContent = `Order ${nextOrder} created for ${customer}.`;
    nextOrder += 1;
  });
})();
