import readline from "readline";

import { listSavedEmails, normalizeEmail } from "../storage/index.js";
import type { SessionIndex } from "../types.js";

export function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

export async function askRequiredEmail(prompt: string): Promise<string> {
    while (true) {
        const answer = normalizeEmail(await ask(prompt));
        if (answer) return answer;
        console.error("Email is required.");
    }
}

export async function selectEmail(index: SessionIndex, explicitEmail: string | null): Promise<string> {
    if (explicitEmail) {
        const normalized = normalizeEmail(explicitEmail);
        if (!normalized) {
            throw new Error("--email was provided but empty");
        }
        return normalized;
    }

    const savedEmails = listSavedEmails(index);

    if (savedEmails.length === 0) {
        return askRequiredEmail("Email address: ");
    }

    if (savedEmails.length === 1) {
        const onlyEmail = savedEmails[0];
        console.log(`Found saved session for ${onlyEmail}.`);
        const answer = await ask(
            `Press Enter to continue with ${onlyEmail}, or type a different email: `
        );
        return answer.trim() ? normalizeEmail(answer) : onlyEmail;
    }

    console.log("Saved sessions:");
    for (let i = 0; i < savedEmails.length; i++) {
        const email = savedEmails[i];
        const lastUsed = index.lastUsedEmail === email ? " (last used)" : "";
        console.log(`  [${i + 1}] ${email}${lastUsed}`);
    }

    while (true) {
        const answer = await ask(`Choose 1-${savedEmails.length} or type a new email: `);
        const trimmed = answer.trim();

        if (!trimmed && index.lastUsedEmail && savedEmails.includes(index.lastUsedEmail)) {
            return index.lastUsedEmail;
        }

        const selected = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(selected) && selected >= 1 && selected <= savedEmails.length) {
            return savedEmails[selected - 1];
        }

        const normalizedEmail = normalizeEmail(trimmed);
        if (normalizedEmail) return normalizedEmail;
        console.error("Please choose a valid number or provide an email.");
    }
}
