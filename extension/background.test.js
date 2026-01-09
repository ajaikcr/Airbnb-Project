/**
 * background.test.js - Automated tests for the Host Genie Bridge
 */

describe('Host Genie Bridge Layer', () => {
    let messageHandler;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        // Mock Chrome API
        global.chrome = {
            runtime: {
                onMessage: {
                    addListener: jest.fn((handler) => {
                        messageHandler = handler;
                    })
                }
            },
            tabs: {
                sendMessage: jest.fn()
            }
        };

        // Mock Fetch and Streams
        global.fetch = jest.fn();
        global.TextDecoder = class {
            decode(val) { return val; }
        };

        // Re-require the script to trigger the constructor
        require('./background.js');
    });

    test('should relay EVENT_NEW_MESSAGE to the agent server', async () => {
        const mockContext = "--- HOST GENIE CONSOLIDATED DATA ---\n[MESSAGE]\nguestName: \"John\"";

        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true })
        });

        // Simulate message from content script
        await messageHandler(
            { type: "EVENT_NEW_MESSAGE", payload: mockContext },
            { tab: { id: 123 } }
        );

        // Verify fetch call
        expect(fetch).toHaveBeenCalledWith(
            "http://localhost:3001/agent/events",
            expect.objectContaining({
                method: "POST",
                body: expect.stringContaining("MESSAGE_RECEIVED")
            })
        );

        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.context).toBe(mockContext);
    });

    test('should handle ACTION_GENERATE_REPLY with a full response', async () => {
        const mockContext = "Need a reply for John";
        const mockReply = "Hello John, welcome!";

        fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ reply: mockReply })
        });

        // Simulate action from content script
        await messageHandler(
            { type: "ACTION_GENERATE_REPLY", payload: mockContext },
            { tab: { id: 123 } }
        );

        // Give the async processing time to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        const sendMessage = chrome.tabs.sendMessage;

        // Verify start notification
        expect(sendMessage).toHaveBeenCalledWith(123, { type: "AI_REPLY_START" });

        // Verify the full reply was relayed
        expect(sendMessage).toHaveBeenCalledWith(123, {
            type: "AI_REPLY_FULL",
            payload: mockReply
        });

        // Verify fetch call
        expect(fetch).toHaveBeenCalledWith(
            "http://localhost:3001/agent/generate-reply",
            expect.objectContaining({
                method: "POST",
                body: expect.stringContaining("GENERATE_REPLY")
            })
        );
    });

    test('should handle server errors gracefully', async () => {
        fetch.mockResolvedValueOnce({
            ok: false,
            status: 500
        });

        await messageHandler(
            { type: "ACTION_GENERATE_REPLY", payload: "test" },
            { tab: { id: 123 } }
        );

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(123, {
            type: "AI_REPLY_ERROR",
            payload: expect.stringContaining("Failed to connect")
        });
    });
});
