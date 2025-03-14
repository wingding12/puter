/*
 * Copyright (C) 2024-present Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const BaseService = require("../../services/BaseService");
const { Endpoint } = require("../../util/expressutil");
const fs = require("fs").promises;
const path = require("path");
const { get_user } = require("../../helpers");
const { USERNAME } = require("../../constants");

/**
 * Setup wizard service for initial Puter configuration
 * Self-registers via boot hook
 */
class SetupService extends BaseService {
  static register(services) {
    services.registerService("setup-wizard", SetupService);
    return true;
  }

  async _init() {
    this.log.info("Initializing Setup Wizard Service");

    // Register the default configuration steps
    this.registerDefaultConfigSteps();

    // Check if setup is completed
    this.setupCompleted = await this.isSetupCompleted();

    if (!this.setupCompleted) {
      this.log.info("Setup not completed, wizard will be displayed");
    } else {
      this.log.info("Setup already completed, skipping wizard");
    }
  }

  /**
   * Helper method for safe logging
   */
  safeLog(level, message, data) {
    if (this.log && typeof this.log[level] === "function") {
      this.log[level](message, data);
    }
  }

  /**
   * Check if setup has been completed
   */
  async isSetupCompleted() {
    try {
      const configPath = path.join(process.cwd(), "config", "setup-completed");
      await fs.access(configPath);
      return true;
    } catch (error) {
      // File doesn't exist, setup not completed
      return false;
    }
  }

  /**
   * Mark setup as completed
   * @param {string} [adminPassword] - Optional admin password to save alongside completion marker
   */
  async markSetupCompleted(adminPassword) {
    try {
      const configDir = path.join(process.cwd(), "config");
      this.safeLog("info", `Ensuring config directory exists at: ${configDir}`);

      // Create config directory if it doesn't exist
      try {
        await fs.mkdir(configDir, { recursive: true });
        this.safeLog("info", "Config directory created or already exists");
      } catch (err) {
        this.safeLog("error", "Error creating config directory", err);
        // Continue anyway, as the error might be that the directory already exists
      }

      // Write a marker file to indicate setup is complete
      const setupCompletedPath = path.join(configDir, "setup-completed");
      this.safeLog(
        "info",
        `Writing setup completed marker to: ${setupCompletedPath}`
      );

      try {
        // Use current timestamp as content
        const timestamp = new Date().toISOString();
        await fs.writeFile(setupCompletedPath, timestamp, "utf8");
        this.safeLog(
          "info",
          `Setup completed marker file written successfully with timestamp: ${timestamp}`
        );

        // If an admin password was provided, save it for server restart
        if (adminPassword) {
          const adminPassPath = path.join(configDir, "admin-password");
          this.safeLog("info", "Saving admin password for server restart");
          await fs.writeFile(adminPassPath, adminPassword, "utf8");
          this.safeLog("info", "Admin password saved for server restart");
        }

        // Update the in-memory flag
        this.setupCompleted = true;

        // Log success
        this.safeLog("info", "Setup marked as completed in memory and on disk");
        return true;
      } catch (writeErr) {
        this.safeLog("error", "Error writing setup-completed file", writeErr);
        throw writeErr;
      }
    } catch (error) {
      this.safeLog("error", "Failed to mark setup as completed", error);
      throw error;
    }
  }

  /**
   * Hook into boot.consolidation to register the service
   */
  ["__on_boot.consolidation"]() {
    this.log.info("Setup Wizard Service consolidated");
  }

  /**
   * Hook into install.routes to serve the setup wizard
   */
  async ["__on_install.routes"](_, { app }) {
    // Ensure app is defined before using it
    if (!app || typeof app.use !== "function") {
      this.safeLog(
        "error",
        "Express app is undefined or invalid in __on_install.routes"
      );
      return;
    }

    this.safeLog("info", "Installing setup wizard routes");

    // Register endpoint for reset instructions
    const { Endpoint } = require("../../util/expressutil");
    const fs = require("fs");
    const path = require("path");

    // Generate a secure random token for setup
    let setupToken = null;
    let tokenPath = null;

    try {
      // Check for existing token
      tokenPath = path.join(process.cwd(), "config", "setup-token");
      setupToken = fs.existsSync(tokenPath)
        ? fs.readFileSync(tokenPath, "utf8")
        : null;
    } catch (err) {
      this.safeLog("error", "Error reading setup token", err);
    }

    // Create a token if not present
    if (!setupToken) {
      try {
        setupToken = require("crypto").randomBytes(32).toString("hex");
        const configDir = path.join(process.cwd(), "config");

        // Ensure config directory exists
        try {
          fs.mkdirSync(configDir, { recursive: true });
        } catch (err) {
          this.safeLog("error", "Error creating config directory", err);
        }

        // Write token to file
        tokenPath = path.join(configDir, "setup-token");
        fs.writeFileSync(tokenPath, setupToken);
        this.safeLog("info", "New setup token generated", { tokenPath });
      } catch (err) {
        this.safeLog("error", "Error generating setup token", err);
      }
    }

    // Helper for consistent logging
    const safeLog = (level, message, data) => {
      if (this.log && typeof this.log[level] === "function") {
        this.log[level](message, data);
      }
    };

    // Token verification middleware
    const verifySetupToken = (req, res, next) => {
      // Skip token verification for the token page itself
      if (req.path === "/__setup/token") {
        return next();
      }

      // Skip token verification for the reset instructions page
      if (req.path === "/__setup/reset-instructions") {
        return next();
      }

      // Skip token verification if viewing the main setup page without submitting
      if (req.path === "/__setup" && req.method === "GET") {
        return next();
      }

      // Skip token verification for the root path when setup is not completed
      if (req.path === "/" && req.method === "GET" && !this.setupCompleted) {
        return next();
      }

      // For other setup routes, verify token
      const token = req.query.token || req.body.token;

      if (!token || token !== setupToken) {
        safeLog("warn", "Invalid setup token", {
          token,
          path: req.path,
          method: req.method,
        });
        return res.redirect("/__setup/token");
      }

      next();
    };

    // Add token page
    Endpoint({
      route: "/__setup/token",
      methods: ["GET"],
      handler: async (req, res) => {
        res.send(this.getSetupTokenHTML(setupToken));
      },
    }).attach(app);

    // Add setup reset endpoint
    Endpoint({
      route: "/__setup/reset",
      methods: ["POST"],
      middleware: [verifySetupToken],
      handler: async (req, res) => {
        try {
          // Delete the setup-completed file
          const setupCompletedPath = path.join(
            process.cwd(),
            "config",
            "setup-completed"
          );

          if (fs.existsSync(setupCompletedPath)) {
            fs.unlinkSync(setupCompletedPath);
          }

          // Update the internal state
          this.setupCompleted = false;

          safeLog("info", "Setup has been reset");

          res.json({
            success: true,
            message:
              "Configuration reset. Setup wizard will be displayed on next visit.",
            setupToken: setupToken,
          });
        } catch (error) {
          this.log.error("Failed to reset configuration", error);
          res.status(500).json({
            success: false,
            message: "Failed to reset configuration",
            error: error.message,
          });
        }
      },
    }).attach(app);

    // Add reset instructions to the token page
    Endpoint({
      route: "/__setup/reset-instructions",
      methods: ["GET"],
      handler: async (req, res) => {
        res.send(this.getResetInstructionsHTML());
      },
    }).attach(app);

    // Wizard UI endpoint - handle both /__setup and root path
    Endpoint({
      route: "/__setup",
      methods: ["GET"],
      handler: async (req, res) => {
        if (this.setupCompleted) {
          return res.redirect("/");
        }

        // Pass the token to the setup wizard HTML
        res.send(this.getSetupWizardHTML(req.query.token || ""));
      },
    }).attach(app);

    // Root path handler when setup is not completed
    if (!this.setupCompleted) {
      Endpoint({
        route: "/",
        methods: ["GET"],
        handler: async (req, res) => {
          // Pass the token to the setup wizard HTML
          res.send(this.getSetupWizardHTML(req.query.token || ""));
        },
      }).attach(app);
    }

    // API status endpoint
    Endpoint({
      route: "/api/status",
      methods: ["GET"],
      handler: async (req, res) => {
        res.json({
          setupCompleted: this.setupCompleted,
          serverTime: new Date().toISOString(),
        });
      },
    }).attach(app);

    // Configuration endpoint
    Endpoint({
      route: "/__setup/configure",
      methods: ["POST"],
      handler: async (req, res) => {
        try {
          // Process all configuration steps
          const config = await this.processConfigSteps(req.body, req);

          // Apply configuration
          try {
            await this.updateConfig(config);
            safeLog("info", "Configuration updated successfully");
          } catch (configError) {
            safeLog("error", "Failed to update configuration", configError);
            return res.status(500).json({
              success: false,
              message: "Failed to update configuration",
              error: configError.message,
            });
          }

          // Mark setup as completed
          try {
            await this.markSetupCompleted(config.__adminPassword);
            safeLog("info", "Setup marked as completed");
          } catch (setupError) {
            safeLog("error", "Failed to mark setup as completed", setupError);
            return res.status(500).json({
              success: false,
              message: "Failed to mark setup as completed",
              error: setupError.message,
            });
          }

          // Remove setup token after successful setup
          if (setupToken) {
            try {
              fs.unlinkSync(tokenPath);
              safeLog("info", "Removed setup token after successful setup");
            } catch (err) {
              safeLog("error", "Failed to remove setup token", err);
            }
          }

          // Check if we need a restart based on the configuration changes
          const needsRestart = this.requiresRestart(config);

          // Success response
          return res.json({
            success: true,
            message: "Setup completed successfully",
            requiresRestart: needsRestart,
            instructions: needsRestart
              ? "Your configuration has been saved. Please restart the Puter server to apply changes. Admin username: admin, Admin password: " +
                (config.__adminPassword || "9668fafe")
              : "Your configuration has been saved and applied successfully. Admin username: admin, Admin password: " +
                (config.__adminPassword || "9668fafe"),
          });
        } catch (error) {
          safeLog("error", "Setup configuration failed", error);
          res.status(500).json({
            success: false,
            message: "Failed to complete setup",
            error: error.message,
          });
        }
      },
    }).attach(app);

    // Middleware to redirect to setup wizard if not completed - only redirect paths that aren't already handled
    if (!this.setupCompleted) {
      app.use((req, res, next) => {
        if (
          req.path === "/" ||
          req.path.startsWith("/__setup") ||
          req.path.startsWith("/api/") ||
          req.path.startsWith("/assets/")
        ) {
          return next();
        }

        // Include token in redirect if available
        const tokenParam = setupToken ? `?token=${setupToken}` : "";
        res.redirect(`/${tokenParam}`);
      });
    }
  }

  /**
   * Updates configuration values
   */
  async updateConfig(newConfig) {
    try {
      // Get the current configuration
      const config = require("../../config");

      // Log the current configuration before changes
      this.safeLog("info", "Current configuration before update", {
        current_config: JSON.stringify({
          domain: config.domain,
          experimental_no_subdomain: config.experimental_no_subdomain,
        }),
      });

      // Apply new settings
      Object.assign(config, newConfig);

      // Log the updated configuration
      this.safeLog("info", "Configuration after update", {
        updated_config: JSON.stringify({
          domain: config.domain,
          experimental_no_subdomain: config.experimental_no_subdomain,
        }),
      });

      // Save configuration to a file
      const configDir = path.join(process.cwd(), "config");
      try {
        await fs.mkdir(configDir, { recursive: true });
      } catch (err) {
        // Directory might already exist
        this.safeLog(
          "warn",
          "Error creating config directory, it might already exist",
          err
        );
      }

      // Write the configuration to a JSON file
      const configPath = path.join(configDir, "wizard-config.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(newConfig, null, 2),
        "utf8"
      );

      this.safeLog("info", "Configuration updated and saved to file", {
        configPath,
      });
      return true;
    } catch (error) {
      this.safeLog("error", "Failed to update configuration", error);
      throw error;
    }
  }

  // Helper method to find a suitable database service
  async findDatabaseService() {
    try {
      // Try different service names that might provide database access
      const possibleServices = [
        "database",
        "db",
        "sql",
        "sqlite",
        "database-access",
      ];

      // Log available services
      const allServices = this.services.list();
      this.safeLog("info", "Available services:", allServices);

      // Try each possible database service
      for (const serviceName of possibleServices) {
        if (this.services.has(serviceName)) {
          const service = this.services.get(serviceName);
          this.safeLog("info", `Found database service: ${serviceName}`, {
            methods: Object.keys(service),
            hasKnex: !!service.knex,
            hasQuery: !!service.query,
          });
          return service;
        }
      }

      throw new Error("No database service found");
    } catch (error) {
      this.safeLog("error", "Error finding database service", error);
      throw error;
    }
  }

  // Update admin user password using a direct database approach
  async updateAdminPassword(password) {
    try {
      if (!password || password.trim() === "") {
        this.safeLog(
          "error",
          "Cannot update admin password: Empty password provided"
        );
        throw new Error("Empty password provided");
      }

      this.safeLog(
        "info",
        `Attempting to update admin password to: ${password}`
      );

      const adminUsername = "admin";
      this.safeLog(
        "info",
        `Looking up admin user with username: ${adminUsername}`
      );

      const user = await get_user({ username: adminUsername, cached: false });

      if (!user) {
        this.safeLog("error", "Admin user not found in database");
        throw new Error("Admin user not found");
      }

      this.safeLog(
        "info",
        `Found admin user with ID: ${user.id}, UUID: ${user.uuid}`
      );

      // Use bcrypt to hash the password
      const bcrypt = require("bcrypt");
      this.safeLog("info", "Generating password hash");
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      this.safeLog("info", `Generated password hash successfully`);

      // Find a suitable database service
      const dbService = await this.findDatabaseService();
      if (!dbService) {
        this.safeLog("error", "No database service found");
        throw new Error("No database service found");
      }

      // Log what we're doing
      this.safeLog("info", `Updating password for user ID: ${user.id}`);

      // Direct SQL update to the users table
      try {
        // Using Knex if available
        if (dbService.knex) {
          this.safeLog("info", "Using Knex for database update");
          const result = await dbService
            .knex("user")
            .where("id", user.id)
            .update({ password: passwordHash });

          this.safeLog("info", `Knex update result: ${result} row(s) affected`);

          if (result !== 1) {
            this.safeLog(
              "warn",
              `Expected to update 1 row, but updated ${result} rows`
            );
          }
        }
        // Using raw query as fallback
        else if (dbService.query) {
          this.safeLog("info", "Using raw query for database update");
          const result = await dbService.query(
            "UPDATE user SET password = ? WHERE id = ?",
            [passwordHash, user.id]
          );

          this.safeLog("info", "Raw query update result", result);
        } else {
          this.safeLog(
            "error",
            "No valid query method found in database service"
          );
          throw new Error("No valid query method found in database service");
        }

        // Force-invalidate any cached user
        const invalidate_cached_user =
          require("../../helpers").invalidate_cached_user;
        invalidate_cached_user(user);
        this.safeLog("info", "Invalidated user cache");

        // Verify the password was updated
        this.safeLog("info", "Verifying password update");
        const updatedUser = await get_user({
          username: adminUsername,
          cached: false,
        });

        if (!updatedUser) {
          this.safeLog(
            "error",
            "Failed to verify password update: User not found after update"
          );
          throw new Error("Failed to verify password update");
        }

        // Try to verify the password was updated correctly
        try {
          this.safeLog("info", "Comparing password with hash");
          const passwordMatch = await bcrypt.compare(
            password,
            updatedUser.password
          );

          if (passwordMatch) {
            this.safeLog(
              "info",
              "Admin password updated and verified successfully"
            );

            // Write password to a separate file for reference
            try {
              const fs = require("fs").promises;
              const path = require("path");
              const configDir = path.join(process.cwd(), "config");
              const passwordLogPath = path.join(
                configDir,
                "admin-password-log.txt"
              );

              await fs.writeFile(
                passwordLogPath,
                `Admin password was set to: ${password} at ${new Date().toISOString()}`,
                "utf8"
              );

              this.safeLog("info", "Logged password for reference");
            } catch (logError) {
              this.safeLog("warn", "Could not log password to file", logError);
            }
          } else {
            this.safeLog(
              "error",
              "Admin password update verification failed: Password doesn't match"
            );
            throw new Error("Password verification failed");
          }
        } catch (verifyError) {
          this.safeLog("error", "Error verifying password update", verifyError);
          throw verifyError;
        }
      } catch (dbError) {
        this.safeLog(
          "error",
          "Failed to update admin password in database",
          dbError
        );
        throw dbError;
      }
    } catch (error) {
      this.safeLog("error", "Error updating admin password", error);
      throw error;
    }
  }

  /**
   * Returns the HTML for the setup wizard interface
   */
  getSetupWizardHTML(token = "") {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Puter Setup Wizard</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            ${this.getWizardStyles()}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <div class="card-header">
                    <h1>Puter Setup</h1>
                    <p>Configure your Puter server installation</p>
                </div>
                <div class="card-body">
                    <form id="setup-form">
                        <input type="hidden" id="setupToken" value="${token}">
                        ${this.getWizardFormContent()}
                    </form>
                </div>
            </div>
        </div>
        
        <script>
            document.addEventListener('DOMContentLoaded', function() {
                // Radio button group functionality
                function setupRadioGroup(groupId) {
                    const radioGroup = document.getElementById(groupId);
                    if (!radioGroup) return;
                    
                    const radioItems = radioGroup.querySelectorAll('.radio-item');
                    
                    radioItems.forEach(item => {
                        item.addEventListener('click', () => {
                            // Remove checked class from all items
                            radioItems.forEach(i => i.classList.remove('checked'));
                            
                            // Add checked class to the clicked item
                            item.classList.add('checked');
                            
                            // Check the radio input
                            const input = item.querySelector('input');
                            input.checked = true;
                            
                            // Trigger change event
                            const event = new Event('change');
                            input.dispatchEvent(event);
                        });
                    });
                }
                
                // Setup radio groups
                setupRadioGroup('subdomain-radio-group');
                setupRadioGroup('domain-radio-group');
                
                // Get user's IP for nip.io domain
                fetch('/api/status')
                    .then(response => response.json())
                    .catch(error => console.error('Error fetching status:', error));
                
                // Update nip.io preview
                const userIp = window.location.hostname.split(':')[0];
                const nipioElement = document.getElementById('nipio-domain');
                if (nipioElement) {
                    nipioElement.textContent = userIp.replace(/\\./g, '-') + '.nip.io';
                }
                
                // Toggle subdomain warning
                const subdomainBehaviorInput = document.querySelector('input[name="subdomainBehavior"]');
                if (subdomainBehaviorInput) {
                    subdomainBehaviorInput.addEventListener('change', function(e) {
                        const warningEl = document.getElementById('subdomain-warning');
                        if (warningEl) {
                            warningEl.style.display = e.target.value === 'disabled' ? 'block' : 'none';
                        }
                    });
                }
                
                // Toggle domain/nip.io inputs
                const domainTypeInput = document.querySelector('input[name="domainType"]');
                if (domainTypeInput) {
                    domainTypeInput.addEventListener('change', function(e) {
                        const domainInput = document.getElementById('domain-input');
                        const nipioInfo = document.getElementById('nipio-info');
                        
                        if (e.target.value === 'domain') {
                            if (domainInput) domainInput.style.display = 'block';
                            if (nipioInfo) nipioInfo.style.display = 'none';
                        } else {
                            if (domainInput) domainInput.style.display = 'none';
                            if (nipioInfo) nipioInfo.style.display = 'block';
                        }
                    });
                }
                
                // Helper function to show feedback
                function showFeedback(message, isSuccess) {
                    const feedbackEl = document.getElementById('setup-feedback');
                    if (feedbackEl) {
                        if (isSuccess) {
                            feedbackEl.innerHTML = '<div class="success"><strong>' + message + '</strong></div>';
                        } else {
                            feedbackEl.innerHTML = '<div class="error">' + message + '</div>';
                        }
                        feedbackEl.className = '';
                        feedbackEl.style.display = 'block';
                    }
                }
                
                // Form submission
                const setupForm = document.getElementById('setup-form');
                if (setupForm) {
                    setupForm.addEventListener('submit', function(e) {
                        e.preventDefault();
                        
                        // Validate form
                        const adminPassword = document.getElementById('adminPassword')?.value || '';
                        const confirmPassword = document.getElementById('confirmPassword')?.value || '';
                        const domainTypeInput = document.querySelector('input[name="domainType"]:checked');
                        const domainType = domainTypeInput?.value || 'domain';
                        const domainName = document.getElementById('domainName')?.value || '';
                        
                        if (adminPassword !== confirmPassword) {
                            showFeedback('Passwords do not match', false);
                            return;
                        }
                        
                        if (domainType === 'domain' && !domainName) {
                            showFeedback('Please enter a domain name', false);
                            return;
                        }
                        
                        // Get the token value
                        const token = document.getElementById('setupToken')?.value || '';
                        
                        // Prepare data for submission
                        const subdomainBehaviorInput = document.querySelector('input[name="subdomainBehavior"]:checked');
                        const formData = {
                            subdomainBehavior: subdomainBehaviorInput?.value || 'enabled',
                            domainName: domainName,
                            useNipIo: domainType === 'nipio',
                            adminPassword: adminPassword
                        };
                        
                        // Submit button loading state
                        const submitBtn = document.getElementById('submit-btn');
                        if (submitBtn) {
                            submitBtn.textContent = 'Setting up...';
                            submitBtn.disabled = true;
                        }
                        
                        // Submit configuration with token in headers
                        fetch('/__setup/configure?token=' + token, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Setup-Token': token
                            },
                            body: JSON.stringify(formData)
                        })
                        .then(response => response.json())
                        .then(data => {
                            if (data.success) {
                                if (data.requiresRestart) {
                                    // Show restart instructions instead of redirecting
                                    const feedbackEl = document.getElementById('setup-feedback');
                                    if (feedbackEl) {
                                        feedbackEl.innerHTML = 
                                            '<div class="success">' +
                                            '<strong>Setup Completed Successfully</strong>' +
                                            '<p>' + (data.instructions || 'Please restart the Puter server to apply changes.') + '</p>' +
                                            '<div class="restart-instructions">' +
                                            '<strong>How to restart:</strong>' +
                                            '<ol>' +
                                            '<li>Stop the server (Ctrl+C in the terminal where Puter is running)</li>' +
                                            '<li>Start the server again</li>' +
                                            '<li>Return to this page after restart</li>' +
                                            '</ol>' +
                                            '</div>' +
                                            '</div>';
                                        feedbackEl.style.display = 'block';
                                    }
                                    
                                    // Change button to indicate completion
                                    if (submitBtn) {
                                        submitBtn.textContent = 'Setup Complete';
                                        submitBtn.disabled = true;
                                    }
                                } else {
                                    showFeedback('Setup completed successfully! Redirecting...', true);
                                    setTimeout(() => {
                                        window.location.href = '/';
                                    }, 1500);
                                }
                            } else {
                                showFeedback('Error: ' + (data.message || 'Unknown error'), false);
                                if (submitBtn) {
                                    submitBtn.textContent = 'Complete Setup';
                                    submitBtn.disabled = false;
                                }
                            }
                        })
                        .catch(error => {
                            showFeedback('Error: ' + error.message, false);
                            if (submitBtn) {
                                submitBtn.textContent = 'Complete Setup';
                                submitBtn.disabled = false;
                            }
                        });
                    });
                }
            });
        </script>
    </body>
    </html>
    `;
  }

  // Extract styles to a separate method for better maintainability
  getWizardStyles() {
    return `
      :root {
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
        
        --background: hsl(0 0% 100%);
        --foreground: hsl(224 71.4% 4.1%);
        
        --card: hsl(0 0% 100%);
        --card-foreground: hsl(224 71.4% 4.1%);
        
        --popover: hsl(0 0% 100%);
        --popover-foreground: hsl(224 71.4% 4.1%);
        
        --primary: hsl(220.9 39.3% 11%);
        --primary-foreground: hsl(210 20% 98%);
        
        --secondary: hsl(220 14.3% 95.9%);
        --secondary-foreground: hsl(220.9 39.3% 11%);
        
        --muted: hsl(220 14.3% 95.9%);
        --muted-foreground: hsl(220 8.9% 46.1%);
        
        --accent: hsl(220 14.3% 95.9%);
        --accent-foreground: hsl(220.9 39.3% 11%);
        
        --destructive: hsl(0 84.2% 60.2%);
        --destructive-foreground: hsl(210 20% 98%);
        
        --border: hsl(220 13% 91%);
        --input: hsl(220 13% 91%);
        --ring: hsl(224 71.4% 4.1%);
        
        --radius: 0.5rem;
      }

      .dark {
        --background: hsl(224 71.4% 4.1%);
        --foreground: hsl(210 20% 98%);
        
        --card: hsl(224 71.4% 4.1%);
        --card-foreground: hsl(210 20% 98%);
        
        --popover: hsl(224 71.4% 4.1%);
        --popover-foreground: hsl(210 20% 98%);
        
        --primary: hsl(210 20% 98%);
        --primary-foreground: hsl(220.9 39.3% 11%);
        
        --secondary: hsl(215 27.9% 16.9%);
        --secondary-foreground: hsl(210 20% 98%);
        
        --muted: hsl(215 27.9% 16.9%);
        --muted-foreground: hsl(217.9 10.6% 64.9%);
        
        --accent: hsl(215 27.9% 16.9%);
        --accent-foreground: hsl(210 20% 98%);
        
        --destructive: hsl(0 62.8% 30.6%);
        --destructive-foreground: hsl(210 20% 98%);
        
        --border: hsl(215 27.9% 16.9%);
        --input: hsl(215 27.9% 16.9%);
        --ring: hsl(216 12.2% 83.9%);
      }
      
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      html {
        font-family: var(--font-sans);
      }
      
      body {
        background-color: var(--background);
        color: var(--foreground);
        font-feature-settings: "rlig" 1, "calt" 1;
        line-height: 1.5;
      }
      
      .container {
        max-width: 600px;
        margin: 2rem auto;
        padding: 1.5rem;
      }

      .card {
        background-color: var(--card);
        border-radius: var(--radius);
        box-shadow: 0px 4px 25px rgba(0, 0, 0, 0.05);
        overflow: hidden;
      }
      
      .card-header {
        padding: 2rem 2rem 1.5rem;
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      
      .card-header h1 {
        margin: 0 0 0.5rem;
        font-size: 1.75rem;
        font-weight: 600;
        color: var(--foreground);
      }
      
      .card-body {
        padding: 2rem;
      }
      
      p {
        color: var(--muted-foreground);
        font-size: 0.9375rem;
      }
      
      .form-group {
        margin-bottom: 1.5rem;
      }
      
      .form-group h2 {
        font-size: 1rem;
        font-weight: 600;
        margin-bottom: 0.75rem;
      }
      
      .form-group p {
        margin-bottom: 1rem;
        font-size: 0.875rem;
      }
      
      .input-group {
        margin-bottom: 1rem;
      }
      
      .label {
        display: block;
        font-size: 0.875rem;
        font-weight: 500;
        margin-bottom: 0.5rem;
      }
      
      .input {
        display: flex;
        width: 100%;
        height: 2.5rem;
        border-radius: var(--radius);
        border: 1px solid var(--input);
        background-color: transparent;
        padding: 0 0.75rem;
        font-size: 0.875rem;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      
      .input:focus {
        outline: none;
        box-shadow: 0 0 0 2px var(--ring);
        border-color: var(--ring);
      }
      
      .radio-group {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.75rem;
      }
      
      .radio-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem;
        border-radius: var(--radius);
        border: 1px solid var(--border);
        background-color: var(--background);
        cursor: pointer;
        transition: all 0.2s ease;
      }
      
      .radio-item:hover {
        background-color: var(--secondary);
      }
      
      .radio-item.checked {
        border-color: var(--primary);
        background-color: var(--accent);
      }
      
      .radio-item input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }
      
      .radio-button {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1rem;
        height: 1rem;
        border-radius: 50%;
        border: 1.5px solid var(--muted-foreground);
      }
      
      .radio-item.checked .radio-button {
        border-color: var(--primary);
      }
      
      .radio-item.checked .radio-button::after {
        content: "";
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background-color: var(--primary);
      }
      
      .radio-label {
        font-size: 0.875rem;
        font-weight: 500;
      }
      
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius);
        font-size: 0.875rem;
        font-weight: 500;
        height: 2.5rem;
        padding-left: 1rem;
        padding-right: 1rem;
        transition: all 0.2s ease;
        cursor: pointer;
      }
      
      .button-primary {
        background-color: var(--primary);
        color: var(--primary-foreground);
        border: none;
      }
      
      .button-primary:hover {
        opacity: 0.9;
      }
      
      .button-primary:active {
        opacity: 0.8;
      }
      
      .button-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .divider {
        height: 1px;
        width: 100%;
        background-color: var(--border);
        margin: 1.5rem 0;
      }
      
      .alert {
        border-radius: var(--radius);
        padding: 0.75rem;
        font-size: 0.875rem;
        margin-top: 0.75rem;
        display: flex;
        gap: 0.5rem;
        align-items: flex-start;
      }
      
      .alert-warning {
        background-color: hsl(48 96% 89%);
        border: 1px solid hsl(38 92% 50%);
        color: hsl(20 94% 30%);
      }
      
      .alert-info {
        background-color: hsl(213 100% 96%);
        border: 1px solid hsl(221 83% 53%);
        color: hsl(224 76% 33%);
      }
      
      .alert-icon {
        flex-shrink: 0;
      }
      
      .conditional {
        margin-top: 0.75rem;
      }
      
      #setup-feedback {
        margin-top: 1.5rem;
        border-radius: var(--radius);
        padding: 1rem;
        font-size: 0.9rem;
        display: none;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
      }
      
      .success {
        background-color: hsl(142 76% 97%);
        border: 1px solid hsl(143 71% 48%);
        color: hsl(140 100% 27%);
      }
      
      .success strong {
        font-size: 1.1rem;
        display: block;
        margin-bottom: 0.75rem;
      }
      
      .success p {
        margin-bottom: 0.75rem;
      }
      
      .error {
        background-color: hsl(0 96% 97%);
        border: 1px solid hsl(0 72% 51%);
        color: hsl(0 74% 39%);
      }
      
      .restart-instructions {
        margin-top: 1.5rem;
        background: var(--secondary);
        padding: 1.25rem;
        border-radius: var(--radius);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }
      
      .restart-instructions strong {
        display: block;
        margin-bottom: 0.75rem;
        font-size: 1rem;
      }
      
      .restart-instructions ol {
        margin-left: 1.5rem;
        margin-top: 0.5rem;
      }
      
      .restart-instructions li {
        margin-bottom: 0.5rem;
      }
      
      @media (max-width: 640px) {
        .container {
          padding: 1rem;
        }
        
        .card-header, .card-body {
          padding: 1.5rem;
        }
        
        .radio-group {
          grid-template-columns: 1fr;
        }
      }
    `;
  }

  // Extract form content to a separate method for better maintainability
  getWizardFormContent() {
    let html = "";

    // Generate HTML for each configuration step
    this.configSteps.forEach((step, index) => {
      html += `
        <div class="form-step" data-step-id="${step.id}">
          <h2>${step.title}</h2>
          ${step.template}
          ${index < this.configSteps.length - 1 ? '<div class="divider"></div>' : ""}
        </div>
      `;
    });

    // Add the submit button and feedback area
    html += `
      <div class="form-actions">
        <button type="submit" id="submit-btn" class="button button-primary">Complete Setup</button>
      </div>
      <div id="setup-feedback" class="feedback"></div>
    `;

    return html;
  }

  // Templates for default configuration steps
  getSubdomainStepTemplate() {
    return `
      <div class="form-group">
        <p>Choose whether to enable or disable subdomains for your Puter instance.</p>
        <div class="radio-group" id="subdomain-radio-group">
          <label class="radio-item checked" data-value="enabled">
            <input type="radio" name="subdomainBehavior" value="enabled" checked>
            <span class="radio-button"></span>
            <span class="radio-label">Enabled (Recommended)</span>
          </label>
          <label class="radio-item" data-value="disabled">
            <input type="radio" name="subdomainBehavior" value="disabled">
            <span class="radio-button"></span>
            <span class="radio-label">Disabled</span>
          </label>
        </div>
        
        <div id="subdomain-warning" class="alert alert-warning" style="display: none;">
          <span class="alert-icon">⚠️</span>
          <div>
            <strong>Security Warning</strong>
            <p style="margin-top: 0.25rem;">Disabling subdomains makes your deployment less secure. Only use this option if your hosting does not support subdomains.</p>
          </div>
        </div>
      </div>
    `;
  }

  getDomainStepTemplate() {
    return `
      <div class="form-group">
        <p>Choose how users will access your Puter instance.</p>
        <div class="radio-group" id="domain-radio-group">
          <label class="radio-item checked" data-value="domain">
            <input type="radio" name="domainType" value="domain" checked>
            <span class="radio-button"></span>
            <span class="radio-label">Custom Domain</span>
          </label>
          <label class="radio-item" data-value="nipio">
            <input type="radio" name="domainType" value="nipio">
            <span class="radio-button"></span>
            <span class="radio-label">Use nip.io (IP-based)</span>
          </label>
        </div>
        
        <div id="domain-input" class="conditional">
          <div class="input-group">
            <label class="label" for="domainName">Domain Name</label>
            <input type="text" id="domainName" name="domainName" class="input" placeholder="e.g., yourdomain.com">
          </div>
        </div>
        
        <div id="nipio-info" class="conditional" style="display: none;">
          <div class="alert alert-info">
            <span class="alert-icon">ℹ️</span>
            <div>
              <strong>Using nip.io</strong>
              <p style="margin-top: 0.25rem;">This will create a domain based on your server's IP address. Your Puter instance will be accessible at: <strong id="nipio-domain">--.--.--.---.nip.io</strong></p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  getPasswordStepTemplate() {
    return `
      <div class="form-group">
        <p>Set a secure password for the admin user.</p>
        <div class="input-group">
          <label class="label" for="adminPassword">Password</label>
          <input type="password" id="adminPassword" name="adminPassword" class="input" placeholder="Enter a secure password">
        </div>
        <div class="input-group">
          <label class="label" for="confirmPassword">Confirm Password</label>
          <input type="password" id="confirmPassword" name="confirmPassword" class="input" placeholder="Confirm your password">
        </div>
      </div>
    `;
  }

  // HTML template for the setup token page
  getSetupTokenHTML(token) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Puter Setup Security</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
                :root {
                    --background: #ffffff;
                    --foreground: #09090b;
                    --card: #ffffff;
                    --card-foreground: #09090b;
                    --primary: #18181b;
                    --primary-foreground: #f8fafc;
                    --secondary: #f1f5f9;
                    --secondary-foreground: #0f172a;
                    --muted: #f1f5f9;
                    --muted-foreground: #64748b;
                    --accent: #f1f5f9;
                    --accent-foreground: #0f172a;
                    --destructive: #ef4444;
                    --destructive-foreground: #f8fafc;
                    --border: #e2e8f0;
                    --input: #e2e8f0;
                    --ring: #0f172a;
                    --radius: 0.5rem;
                }
                
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body {
                    font-family: 'Inter', sans-serif;
                    background-color: #f9fafb;
                    color: var(--foreground);
                    line-height: 1.5;
                }
                
                .container {
                    max-width: 550px;
                    margin: 2rem auto;
                    padding: 1.5rem;
                }
                
                .card {
                    background-color: var(--card);
                    border-radius: var(--radius);
                    box-shadow: 0px 2px 8px rgba(0, 0, 0, 0.08);
                    overflow: hidden;
                }
                
                .card-header {
                    padding: 1.5rem;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                }
                
                h1 {
                    font-size: 1.5rem;
                    font-weight: 600;
                    color: var(--foreground);
                    margin-bottom: 0.5rem;
                }
                
                .description {
                    font-size: 0.875rem;
                    color: var(--muted-foreground);
                    max-width: 500px;
                    margin: 0 auto;
                }
                
                .card-content {
                    padding: 1.5rem;
                }
                
                .token-display {
                    background-color: var(--muted);
                    border-radius: var(--radius);
                    padding: 1rem;
                    margin: 1.5rem 0;
                    font-family: monospace;
                    word-break: break-all;
                    text-align: center;
                    font-size: 0.875rem;
                }
                
                .button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: var(--radius);
                    font-size: 0.875rem;
                    font-weight: 500;
                    height: 2.5rem;
                    padding-left: 1rem;
                    padding-right: 1rem;
                    transition: all 0.2s ease;
                    cursor: pointer;
                    width: 100%;
                    margin-top: 1rem;
                }
                
                .button-primary {
                    background-color: var(--primary);
                    color: var(--primary-foreground);
                    border: none;
                }
                
                .button-primary:hover {
                    opacity: 0.9;
                }
                
                .alert {
                    border-radius: var(--radius);
                    padding: 0.75rem;
                    font-size: 0.875rem;
                    margin-top: 0.75rem;
                    display: flex;
                    gap: 0.5rem;
                    align-items: flex-start;
                }
                
                .alert-warning {
                    background-color: #fff7ed;
                    border: 1px solid #ffedd5;
                    color: #c2410c;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <div class="card-header">
                        <h1>Security Token Required</h1>
                        <p class="description">To protect your Puter instance during setup, a security token is required.</p>
                    </div>
                    
                    <div class="card-content">
                        <p>Your setup security token is:</p>
                        <div class="token-display">${token}</div>
                        
                        <div class="alert alert-warning">
                            <span>⚠️</span>
                            <span>This token is only shown once and provides administrative access to configure your Puter instance. Keep it secure.</span>
                        </div>
                        
                        <a href="/__setup?token=${token}" class="button button-primary">Continue to Setup</a>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `;
  }

  // HTML template for reset instructions
  getResetInstructionsHTML() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Puter Setup Reset Instructions</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
                :root {
                    --background: #ffffff;
                    --foreground: #09090b;
                    --card: #ffffff;
                    --card-foreground: #09090b;
                    --primary: #18181b;
                    --primary-foreground: #f8fafc;
                    --secondary: #f1f5f9;
                    --secondary-foreground: #0f172a;
                    --muted: #f1f5f9;
                    --muted-foreground: #64748b;
                    --accent: #f1f5f9;
                    --accent-foreground: #0f172a;
                    --destructive: #ef4444;
                    --destructive-foreground: #f8fafc;
                    --border: #e2e8f0;
                    --input: #e2e8f0;
                    --ring: #0f172a;
                    --radius: 0.5rem;
                }
                
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body {
                    font-family: 'Inter', sans-serif;
                    background-color: #f9fafb;
                    color: var(--foreground);
                    line-height: 1.5;
                }
                
                .container {
                    max-width: 550px;
                    margin: 2rem auto;
                    padding: 1.5rem;
                }
                
                .card {
                    background-color: var(--card);
                    border-radius: var(--radius);
                    box-shadow: 0px 2px 8px rgba(0, 0, 0, 0.08);
                    overflow: hidden;
                }
                
                .card-header {
                    padding: 1.5rem;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                }
                
                h1 {
                    font-size: 1.5rem;
                    font-weight: 600;
                    color: var(--foreground);
                    margin-bottom: 0.5rem;
                }
                
                .description {
                    font-size: 0.875rem;
                    color: var(--muted-foreground);
                    max-width: 500px;
                    margin: 0 auto;
                }
                
                .card-content {
                    padding: 1.5rem;
                }
                
                .instructions {
                    margin-top: 1.5rem;
                    text-align: left;
                }
                
                .instructions p {
                    margin-bottom: 1rem;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <div class="card-header">
                        <h1>Reset Instructions</h1>
                        <p class="description">Follow these steps to reset your Puter instance.</p>
                    </div>
                    
                    <div class="card-content">
                        <div class="instructions">
                            <p>1. Remove the setup-completed marker file.</p>
                            <p>2. Remove the setup-token file.</p>
                            <p>3. Restart the Puter instance.</p>
                        </div>
                        
                        <a href="/__setup" class="button button-primary">Continue to Setup</a>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `;
  }

  // Constructor to initialize basic properties
  _construct() {
    // Initialize the configuration steps registry
    this.configSteps = [];
  }

  // Register the default configuration steps
  registerDefaultConfigSteps() {
    // Register the subdomain configuration step
    this.registerConfigStep({
      id: "subdomain",
      title: "Subdomain Configuration",
      description: "Configure how subdomains work in your Puter instance",
      required: true,
      order: 10,
      template: this.getSubdomainStepTemplate(),
      process: async (data) => {
        return {
          experimental_no_subdomain: data.subdomainBehavior === "disabled",
        };
      },
    });

    // Register the domain configuration step
    this.registerConfigStep({
      id: "domain",
      title: "Domain Configuration",
      description: "Set up the domain name for your Puter instance",
      required: true,
      order: 20,
      template: this.getDomainStepTemplate(),
      process: async (data, req) => {
        return {
          domain: data.useNipIo
            ? `${req.ip.replace(/\./g, "-")}.nip.io`
            : data.domainName,
        };
      },
    });

    // Register the admin password configuration step
    this.registerConfigStep({
      id: "adminPassword",
      title: "Admin Password",
      description: "Set the password for the admin user",
      required: true,
      order: 30,
      template: this.getPasswordStepTemplate(),
      process: async (data) => {
        if (data.adminPassword && data.adminPassword.trim()) {
          try {
            await this.updateAdminPassword(data.adminPassword);
            this.safeLog("info", "Admin password updated successfully");
            // Return an empty object since we're handling the password separately
            return {};
          } catch (passwordError) {
            this.safeLog(
              "error",
              "Failed to update admin password",
              passwordError
            );
            // Don't throw error to allow setup to continue
            return {};
          }
        }
        return {};
      },
    });
  }

  /**
   * Register a new configuration step for the setup wizard
   * @param {Object} step The configuration step definition
   */
  registerConfigStep(step) {
    if (!step.id || !step.title || !step.template || !step.process) {
      throw new Error(
        "Configuration step must have id, title, template and process function"
      );
    }

    // Add the step to the registry
    this.configSteps.push({
      id: step.id,
      title: step.title,
      description: step.description || "",
      required: step.required !== false,
      order: step.order || 999,
      template: step.template,
      process: step.process,
    });

    // Sort steps by order
    this.configSteps.sort((a, b) => a.order - b.order);

    // Only log if logger is available (might not be during construction)
    if (this.log && typeof this.log.info === "function") {
      this.log.info(`Registered configuration step: ${step.id}`);
    }
  }

  /**
   * Process all configuration steps with the provided data
   */
  async processConfigSteps(data, req) {
    let config = {};

    // Store the admin password separately
    let adminPassword = null;

    // Process each step in order
    for (const step of this.configSteps) {
      try {
        this.safeLog("info", `Processing configuration step: ${step.id}`);
        const stepConfig = await step.process.call(this, data, req);

        // If this is the admin password step, store the password
        if (step.id === "adminPassword" && data.adminPassword) {
          adminPassword = data.adminPassword;
        }

        config = { ...config, ...stepConfig };
      } catch (error) {
        this.safeLog("error", `Error processing step ${step.id}`, error);
        throw error;
      }
    }

    // Store the admin password in the config object for later use
    // This won't be included in the global config but will be used for setup
    if (adminPassword) {
      config.__adminPassword = adminPassword;
    }

    return config;
  }

  /**
   * Determines if server restart is required based on configuration changes
   * @param {Object} newConfig - The newly applied configuration
   * @returns {boolean} - True if restart is required
   */
  requiresRestart(newConfig) {
    // These configuration options require a server restart to take effect
    const restartRequiredOptions = [
      "domain",
      "experimental_no_subdomain",
      "http_port",
      "api_base_url",
      "origin",
    ];

    // Check if any restart-required options were changed
    for (const option of restartRequiredOptions) {
      if (option in newConfig) {
        this.safeLog(
          "info",
          `Configuration change to '${option}' requires server restart`
        );
        return true;
      }
    }

    return false;
  }
}

// Self-registration when the file is required.
// This will register with the service system without modifying SelfHostedModule.js
const serviceContainer = global.services || global.__service_container__;
if (serviceContainer) {
  SetupService.register(serviceContainer);
}

module.exports = {
  SetupService,
};
