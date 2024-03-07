import { logger } from "./logger.js";
import { parseUnits } from "./units.js";
import {
    ActivateChain,
    EventMap,
    Glue,
    Report,
    RequestAccounts,
    RequestAccountsEvent,
    SendTransaction,
    SendTransactionEvent,
    SignMessage,
    SignMessageEvent,
    SignTransaction,
    SignTransactionEvent,
    SwitchEthereumChain,
} from "@wallet-test-framework/glue";
import { URL } from "node:url";
import { Builder, By, WebDriver, until } from "selenium-webdriver";
import Chrome from "selenium-webdriver/chrome.js";

function delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

class Lock<T> {
    private readonly data: T;
    private readonly queue: (() => Promise<void>)[];
    private locked: boolean;

    constructor(data: T) {
        this.data = data;
        this.queue = [];
        this.locked = false;
    }

    public unsafe(): T {
        return this.data;
    }

    public lock<R>(callback: (data: T) => Promise<R>): Promise<R> {
        if (this.locked) {
            logger.debug("Queuing");
            return new Promise<R>((res, rej) => {
                this.queue.push(() => callback(this.data).then(res).catch(rej));
            });
        }

        logger.debug("Locking");
        this.locked = true;
        return callback(this.data).finally(() => this.after());
    }

    private after() {
        if (0 === this.queue.length) {
            logger.debug("Unlocking");
            this.locked = false;
        } else {
            const item = this.queue.shift();
            logger.debug("Running task", item);
            if (typeof item === "undefined") {
                throw new Error("lock queue empty");
            }

            void item().finally(() => this.after());
        }
    }
}

class TahoDriver {
    public static readonly PASSWORD = "ethereum1";
    private readonly newWindows: string[];
    private readonly driver: Lock<WebDriver>;
    private running: boolean;
    private windowWatcher: Promise<void>;
    private readonly glue: TahoGlue;
    public extensionUrl: string | null;

    private constructor(driver: WebDriver, glue: TahoGlue) {
        this.driver = new Lock(driver);
        this.running = true;
        this.windowWatcher = this.watchWindows();
        this.newWindows = [];
        this.glue = glue;
        this.extensionUrl = null;
    }

    public static async create(
        glue: TahoGlue,
        extensionPath: string,
        browserVersion: string | null | undefined,
    ): Promise<TahoDriver> {
        const chrome = new Chrome.Options();
        if (typeof browserVersion === "string") {
            chrome.setBrowserVersion(browserVersion);
        }
        chrome.addExtensions(extensionPath);

        const driver = await new Builder()
            .forBrowser("chrome")
            .setChromeOptions(chrome)
            .build();

        await driver.manage().setTimeouts({ implicit: 10000 });

        return new TahoDriver(driver, glue);
    }

    public async unlockWithPassword(_driver: WebDriver): Promise<void> {
        //TODO: type password if wallet is locked
    }

    private async emitRequestAccounts(
        driver: WebDriver,
        handle: string,
    ): Promise<void> {
        logger.debug("emitting requestaccounts");
        await this.unlockWithPassword(driver);

        this.glue.emit(
            "requestaccounts",
            new RequestAccountsEvent(handle, {
                accounts: [],
            }),
        );
    }

    private async emitSendTransaction(
        driver: WebDriver,
        handle: string,
    ): Promise<void> {
        logger.debug("emitting sendtransaction");
        await this.unlockWithPassword(driver);

        const addressDetails = await driver.findElement(
            By.css("#recipientAddress"),
        );
        const addressTitle = await addressDetails.getAttribute("title");
        const toAddress = addressTitle
            .substring(addressTitle.indexOf(":") + 1)
            .trim();
        const senderInfo = await driver.findElement(
            By.css(".account_info_label"),
        );
        const fromAddress = await senderInfo.getAttribute("title");
        const spendAmount = await driver.findElement(By.css(".spend_amount"));
        const textCost = await spendAmount.getText();
        const cost = /[0-9]+(.[0-9]+)?(?= BNB)/.exec(textCost)?.[0] || "";
        const parsedCost = parseUnits(cost, 18);

        this.glue.emit(
            "sendtransaction",
            new SendTransactionEvent(handle, {
                from: fromAddress,
                to: toAddress,
                data: "",
                value: parsedCost.toString(),
            }),
        );
    }

    private async emitSignTransaction(
        driver: WebDriver,
        handle: string,
    ): Promise<void> {
        logger.debug("emitting signtransaction");
        await this.unlockWithPassword(driver);

        const addressDetails = await driver.findElement(
            By.css("#recipientAddress"),
        );
        const addressTitle = await addressDetails.getAttribute("title");
        const toAddress = addressTitle
            .substring(addressTitle.indexOf(":") + 1)
            .trim();
        const senderInfo = await driver.findElement(
            By.css(".account_info_label"),
        );
        const fromAddress = await senderInfo.getAttribute("title");
        const spendAmount = await driver.findElement(By.css(".spend_amount"));
        const textCost = await spendAmount.getText();
        const cost = /[0-9]+(.[0-9]+)?(?= BNB)/.exec(textCost)?.[0] || "";
        const parsedCost = parseUnits(cost, 18);

        this.glue.emit(
            "signtransaction",
            new SignTransactionEvent(handle, {
                from: fromAddress,
                to: toAddress,
                data: "",
                value: parsedCost.toString(),
            }),
        );
    }

    private async emitSignMessage(
        driver: WebDriver,
        handle: string,
    ): Promise<void> {
        logger.debug("emitting signmessage");
        await this.unlockWithPassword(driver);

        const messageContent = await driver.findElement(
            By.css("[data-testid='message-content']"),
        );
        const message = await messageContent.getText();

        this.glue.emit(
            "signmessage",
            new SignMessageEvent(handle, {
                message: message,
            }),
        );
    }

    private async processNewWindow(
        driver: WebDriver,
        handle: string,
    ): Promise<void> {
        logger.debug("Processing window", handle);
        await driver.switchTo().window(handle);

        const location = await driver.getCurrentUrl();
        const url = new URL(location);
        const action = url.searchParams.get("page");

        let title;
        switch (action) {
            case "/dapp-permission":
                await this.emitRequestAccounts(driver, handle);
                break;
            case "/sign-transaction":
                {
                    const sections = await driver.findElements(
                        By.css(`[data-broadcast-on-sign]`),
                    );
                    if (sections.length === 0) {
                        break;
                    }
                    const section = sections[0];
                    const broadcastOnSign = await section.getAttribute(
                        "data-broadcast-on-sign",
                    );
                    if (broadcastOnSign === "true") {
                        await this.emitSendTransaction(driver, handle);
                    } else {
                        await this.emitSignTransaction(driver, handle);
                    }
                }
                break;
            case "signEthereumMessage":
                await this.emitSignMessage(driver, handle);
                break;
            default:
                title = await driver.getTitle();
                logger.warn(
                    "unknown event from window",
                    title,
                    "@",
                    location,
                    "(",
                    handle,
                    ")",
                );
                return;
        }
    }

    private async processNewWindows(): Promise<void> {
        await this.driver.lock(async (driver) => {
            const popped = this.newWindows.splice(0);

            let current = null;

            try {
                current = await driver.getWindowHandle();
            } catch {
                /* no-op */
            }

            try {
                for (const one of popped) {
                    try {
                        await this.processNewWindow(driver, one);
                    } catch (e) {
                        logger.debug("Window", one, "disappeared");
                        continue;
                    }
                }
            } finally {
                if (current) {
                    await driver.switchTo().window(current);
                }
            }
        });
    }

    private async watchWindows(): Promise<void> {
        let previous: string[] = await this.driver
            .unsafe()
            .getAllWindowHandles();

        while (this.running) {
            const next = await this.driver.unsafe().getAllWindowHandles();
            const created = next.filter((v) => !previous.includes(v));
            previous = next;

            if (created.length > 0) {
                logger.debug("Found windows", created);
                this.newWindows.push(...created);
                await this.processNewWindows();
            }

            await delay(500);
        }
    }

    public lock<T>(callback: (wb: WebDriver) => Promise<T>): Promise<T> {
        return this.driver.lock(callback);
    }

    public async setup(): Promise<void> {
        await this.driver.lock(async (driver) => {
            let extensionUrl = await driver.wait(async () => {
                const handles = await driver.getAllWindowHandles();
                for (const handle of handles) {
                    await driver.switchTo().window(handle);
                    const url = await driver.getCurrentUrl();

                    if (url.indexOf("-extension://")) {
                        return url;
                    }
                }
            }, 10000);
            if (!extensionUrl) {
                throw new Error("Failed to find extension window.");
            }
            extensionUrl = extensionUrl.substring(0, extensionUrl.indexOf("#"));
            extensionUrl = extensionUrl.substring(
                0,
                extensionUrl.lastIndexOf("/"),
            );
            this.extensionUrl = extensionUrl + "/popup.html";

            const importExisting = await driver.findElement(
                By.css("#existingWallet"),
            );
            await driver.wait(until.elementIsVisible(importExisting), 2000);
            await importExisting.click();

            const byPhrase = await driver.findElement(By.css("#importSeed"));
            await driver.wait(until.elementIsVisible(byPhrase), 2000);
            await byPhrase.click();

            const setPassword = await driver.findElement(By.css("#password"));
            await driver.wait(until.elementIsVisible(setPassword), 2000);
            await setPassword.click();
            await setPassword.sendKeys(TahoDriver.PASSWORD);

            const setPasswordVerify = await driver.findElement(
                By.css("#passwordConfirm"),
            );
            await driver.wait(until.elementIsVisible(setPasswordVerify), 2000);
            await setPasswordVerify.sendKeys("ethereum1");

            const passwordContinue = await driver.findElement(
                By.css("#confirm:not([disabled])"),
            );
            await driver.wait(until.elementIsVisible(passwordContinue), 2000);
            await passwordContinue.click();

            const secretInput = await driver.findElement(
                By.css("#recovery_phrase"),
            );
            await driver.wait(until.elementIsVisible(secretInput), 2000);
            await secretInput.sendKeys(
                "basket cradle actor pizza similar liar suffer another all fade flag brave",
            );

            const importWallet = await driver.findElement(By.css("#import"));
            await driver.wait(until.elementIsVisible(importWallet), 2000);
            await importWallet.click();

            const anim = await driver.findElement(By.css("[src$='.gif']"));
            await driver.wait(until.elementIsVisible(anim), 2000);

            await driver.close();
            const handles = await driver.getAllWindowHandles();
            await driver.switchTo().window(handles[0]);
        });
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.driver.lock(async (driver) => {
            await driver.quit();
        });
    }
}

export class TahoGlue extends Glue {
    private static async buildDriver(
        glue: TahoGlue,
        extensionPath: string,
        browserVersion: string | null | undefined,
    ): Promise<TahoDriver> {
        const taho = await TahoDriver.create(
            glue,
            extensionPath,
            browserVersion,
        );
        await taho.setup();
        return taho;
    }

    private readonly driver;
    public readonly reportReady: Promise<Report>;
    private readonly resolveReport: (report: Report) => unknown;

    constructor(
        extensionPath: string,
        browserVersion: string | null | undefined,
    ) {
        super();
        this.driver = TahoGlue.buildDriver(this, extensionPath, browserVersion);

        let resolveReport;
        this.reportReady = new Promise((res) => {
            resolveReport = res;
        });

        if (!resolveReport) {
            throw new Error("Promise didn't assign resolve function");
        }

        this.resolveReport = resolveReport;
    }

    async launch(url: string): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            await driver.navigate().to(url);

            const btn = await driver.findElement(By.css("#connect"));
            await driver.wait(until.elementIsVisible(btn), 2000);
            await btn.click();
        });
    }

    override async activateChain(action: ActivateChain): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            const current = await driver.getWindowHandle();
            await driver.switchTo().newWindow("window");
            await driver.navigate().to("https://chainlist.org/");
            const chainListWindow = await driver.getWindowHandle();
            const openWindows = await driver.getAllWindowHandles();

            await driver.executeScript(
                `ethereum.request({method:"eth_requestAccounts"});`,
            );
            const popupWindow = await driver.wait(async () => {
                const handles = await driver.getAllWindowHandles();
                const newHandles = handles.filter(
                    (x) => !openWindows.includes(x),
                );
                return newHandles[0];
            });
            openWindows.push(popupWindow);

            await driver.switchTo().window(popupWindow);

            const btn = await driver.findElement(By.css("#close"));
            await driver.wait(until.elementIsVisible(btn), 2000);
            await btn.click();

            const btn2 = await driver.findElement(By.css("#grantPermission"));
            await driver.wait(until.elementIsVisible(btn2), 2000);
            await btn2.click();

            await driver.switchTo().window(chainListWindow);
            await driver.executeScript(
                `ethereum.request({"method":"wallet_addEthereumChain","params":[{"chainId":"${action.chainId}","chainName":"BNB Chain LlamaNodes","nativeCurrency":{"name":"BNB Chain Native Token","symbol":"BNB","decimals":18},"rpcUrls":["${action.rpcUrl}"],"blockExplorerUrls":["https://bscscan.com"]},"0xb7b4d68047536a87f0926a76dd0b96b3a044c8cf","Chainlist"]});`,
            );

            const addChainWindow = await driver.wait(async () => {
                const handles = await driver.getAllWindowHandles();
                const newHandles = handles.filter(
                    (x) => !openWindows.includes(x),
                );
                return newHandles[0];
            });
            await driver.switchTo().window(addChainWindow);

            const btn3 = await driver.findElement(By.css("#addNewChain"));
            await driver.wait(until.elementIsVisible(btn3), 2000);
            await btn3.click();

            await driver.switchTo().window(chainListWindow);
            await driver.close();

            await driver.switchTo().window(current);
        });
    }

    override async requestAccounts(action: RequestAccounts): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            const current = await driver.getWindowHandle();
            try {
                await driver.switchTo().window(action.id);
                let testid: string;

                switch (action.action) {
                    case "approve":
                        testid = "grantPermission";
                        break;
                    case "reject":
                        testid = "denyPermission";
                        break;
                    default:
                        throw new Error(
                            `unsupported action ${action as string}`,
                        );
                }

                const btn = await driver.findElement(
                    By.css(`#${testid}:not([disabled])`),
                );
                await driver.wait(until.elementIsVisible(btn), 2000);
                await btn.click();
            } finally {
                await driver.switchTo().window(current);
            }
        });
    }

    override async signMessage(action: SignMessage): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            const current = await driver.getWindowHandle();
            try {
                await driver.switchTo().window(action.id);
                let testid: string;

                switch (action.action) {
                    case "approve":
                        testid = "sign-message";
                        break;
                    case "reject":
                        testid = "cancel-message";
                        break;
                    default:
                        throw new Error(
                            `unsupported action ${action as string}`,
                        );
                }

                const btn = await driver.findElement(
                    By.css(`[data-testid='${testid}']:not([disabled])`),
                );
                await driver.wait(until.elementIsVisible(btn), 2000);
                await btn.click();
            } finally {
                await driver.switchTo().window(current);
            }
        });
    }

    override async sendTransaction(action: SendTransaction): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            const current = await driver.getWindowHandle();
            try {
                await driver.switchTo().window(action.id);
                let testid: string;

                switch (action.action) {
                    case "approve":
                        testid = "request-confirm-button";
                        break;
                    case "reject":
                        testid = "request-cancel-button";
                        break;
                    default:
                        throw new Error(
                            `unsupported action ${action as string}`,
                        );
                }

                const btn = await driver.findElement(
                    By.css(`[data-testid='${testid}']:not([disabled])`),
                );
                await driver.wait(until.elementIsVisible(btn), 2000);
                await btn.click();
            } finally {
                await driver.switchTo().window(current);
            }
        });
    }

    override async signTransaction(action: SignTransaction): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            const current = await driver.getWindowHandle();
            try {
                await driver.switchTo().window(action.id);
                let testid: string;

                switch (action.action) {
                    case "approve":
                        testid = "sign";
                        break;
                    case "reject":
                        testid = "reject";
                        break;
                    default:
                        throw new Error(
                            `unsupported action ${action as string}`,
                        );
                }

                const btn = await driver.findElement(
                    By.css(`#${testid}:not(.disabled)`),
                );
                await driver.wait(until.elementIsVisible(btn), 2000);
                await btn.click();
            } finally {
                await driver.switchTo().window(current);
            }
        });
    }

    // TODO: Remove eslint comment after implementing.
    // eslint-disable-next-line @typescript-eslint/require-await
    override async switchEthereumChain(
        _action: SwitchEthereumChain,
    ): Promise<void> {
        throw new Error("cb - switchEthereumChain not implemented");
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    override async report(action: Report): Promise<void> {
        await (await this.driver).stop();
        this.resolveReport(action);
    }

    public emit<E extends keyof EventMap>(
        type: E,
        ...ev: Parameters<EventMap[E]>
    ): void {
        super.emit(type, ...ev);
    }
}
