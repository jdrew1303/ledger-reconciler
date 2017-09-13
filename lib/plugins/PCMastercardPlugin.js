const BasePlugin = require('./BasePlugin');

class PCMastercardPlugin extends BasePlugin {
  constructor(browser, logger, pluginArgs) {
    super(browser, logger, pluginArgs);

    if (!this.pluginArgs.username) {
      if (!process.env.PCMC_PLUGIN_USERNAME) {
        throw new Error('You do not appear to have either the "username" key set in your config file for the PC Mastercard plugin.');
      }
      this.pluginArgs.username = process.env.PCMC_PLUGIN_USERNAME;
    }

    if (!this.pluginArgs.password) {
      if (!process.env.PCMC_PLUGIN_PASSWORD) {
        throw new Error('You do not appear to have either the "password" key set in your config file for the PC Mastercard plugin.');
      }
      this.pluginArgs.password = process.env.PCMC_PLUGIN_PASSWORD;
    }

    if (!this.pluginArgs.securityAnswer) {
      if (!process.env.PCMC_PLUGIN_SECURITYANSWER) {
        throw new Error('You do not appear to have either the "securityAnswer" key set in your config file for the PC Mastercard plugin.');
      }
      this.pluginArgs.securityAnswer = process.env.PCMC_PLUGIN_SECURITYANSWER;
    }

    this.parseTransactionRows = this.parseTransactionRows.bind(this);
    this.getMostRecentTransactionDate = this.getMostRecentTransactionDate.bind(this);

    this.configuredMostRecentTransactionDate = 0;
    this.updatedMostRecentTransactionDate = 0;
    if (this.pluginArgs.mostRecentTransactionDate) {
      this.configuredMostRecentTransactionDate = this.pluginArgs.mostRecentTransactionDate;
      this.updatedMostRecentTransactionDate = this.pluginArgs.mostRecentTransactionDate;
    }

    this.remainingBalance = 'undefined';
  }

  // istanbul ignore next
  async scrapeTransactions() {
    const page = await this.browser.newPage();
    page.on('console', this.logger.debug);

    this.logger.debug('Initialing transaction download');

    // Bring up the PC Mastercard login page
    await page.goto('https://online.pcmastercard.ca/PCB_Consumer/Login.do');

    // Fill in the username
    await page.click('input[name="username"]');
    await page.type(this.pluginArgs.username);

    // Fill in the password
    await page.click('input[name="password"]');
    await page.type(this.pluginArgs.password);

    // Click "Sign On"
    await page.click('#content > div.module-login.module.clearfix > div.module-content > form > div.actions.group.clearfix > div:nth-child(2) > input[type="submit"]');
    await page.waitForNavigation();

    // Fill in the answer to one of the security questions, if presented
    const securityAnswerField = await page.$('form[name="secondaryUserAuthForm"] input[name="hintanswer"]');
    if (securityAnswerField) {
      await securityAnswerField.click();
      await page.type(this.pluginArgs.securityAnswer);
      await page.click('input[type="submit"][name="submitNext"]');
      await page.waitForNavigation();
    }

    this.logger.debug('Successfully logged in');

    // Get the current balance
    const currentBalanceSelector = '#main > div > div.sidebar.column > div.module-make-payment.module.hide-on-mobile.clearfix > div > div.value > span';
    const currentBalance = await page.$eval(currentBalanceSelector, (el) => el.innerHTML);
    this.remainingBalance = currentBalance;
    this.logger.debug(`Current balance is: ${this.remainingBalance}`);

    const availableStatements = await page.evaluate((sel) => {
      const rows = [...document.querySelectorAll(sel)];
      return rows.map((row) => {
        return row.getAttribute('value');
      });
    }, 'form[name="transHistoryForm"] select[name="cycleDate"] option');

    let transactions = [];

    for (let stmt of availableStatements) {
      if (!stmt) {
        this.logger.debug(`Nothing to process with "${stmt}", moving along`);
        continue;
      }

      this.logger.debug(`Now processing statement: ${stmt}`);

      // Select the current statement from the statement cycle list
      await page.click('form[name="transHistoryForm"] a.selectBox');
      await page.click(`body > ul.selectBox-dropdown-menu > li > a[rel="${stmt}"]`);
      await page.waitForNavigation();

      const tRows = await this.parseTransactionRows(page);
      transactions = [...transactions, ...tRows];
    }

    return transactions;
  }

  // istanbul ignore next
  async parseTransactionRows(page) {
    // Parse the individual transaction entries in the displayed table
    const {transactionList, mostRecentDateWeveSeen} = await page.evaluate((sel, configuredMostRecentTransactionDate, updatedMostRecentTransactionDate) => {
      let transactionList = [];
      let mostRecentDateWeveSeen = updatedMostRecentTransactionDate;

      const rows = [...document.querySelectorAll(sel)];
      rows.forEach((row) => {
        const eles = [...row.querySelectorAll('td')];

        const rawDate = eles[1].innerHTML.replace(/&nbsp;/g, '').replace(/,/g, '');
        const epochDate = Date.parse(rawDate);
        // ignore any dates that can't be parsed - i.e. header rows
        if (isNaN(epochDate)) {
          return;
        }

        // Discard this transaction if it is older than we care for
        if (epochDate <= configuredMostRecentTransactionDate) {
          console.log(`Discarding transaction from ${epochDate} as it is too old to process`);
          return;
        }
        console.log(`Processing transaction from ${epochDate}`);

        // Make note of the most recent transaction date
        if (epochDate >= mostRecentDateWeveSeen) {
          mostRecentDateWeveSeen = epochDate;
        }

        const merchant = eles[2].innerText.trim();

        let creditAmt;
        const debitAmt = eles[3].innerText.trim();
        if (debitAmt.startsWith('-')) {
          creditAmt = debitAmt.substring(1);
        }

        transactionList.push({
          date: epochDate,
          amount: creditAmt ? `(${creditAmt})` : debitAmt,
          merchant: `"${merchant}"`,
        });
      });

      return {
        transactionList,
        mostRecentDateWeveSeen,
      };
    }, 'table[id="sortTable"] > tbody > tr', this.configuredMostRecentTransactionDate, this.updatedMostRecentTransactionDate);

    // Set the mostRecentTransactionDate instance value
    this.updatedMostRecentTransactionDate = mostRecentDateWeveSeen;

    return transactionList;
  }

  getMostRecentTransactionDate() {
    return this.updatedMostRecentTransactionDate;
  }

  getRemainingBalance() {
    return this.remainingBalance;
  }
}

module.exports = PCMastercardPlugin;