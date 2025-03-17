const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Add to the top of scraper.js
const browserPool = [];
const MAX_BROWSERS = 5;

async function getOrCreateBrowser() {
  if (browserPool.length > 0) {
    return browserPool.pop();
  }
  
  return await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      // ...existing args
    ]
  });
}

// At the top of your scraper.js
const scrapingQueue = [];
let isProcessing = false;
const RATE_LIMIT_DELAY = 200; // 2 seconds between requests

const productCache = new Map();
const CACHE_TTL = 604800000; // 1 hour in milliseconds

async function processQueue() {
  if (isProcessing || scrapingQueue.length === 0) return;
  
  isProcessing = true;
  const { url, resolve, reject } = scrapingQueue.shift();
  
  console.log(`Processing queue item: ${url}`);
  
  try {
    const result = await actualScrapeFunction(url);
    resolve(result);
  } catch (error) {
    console.error('Error in processQueue:', error);
    reject(error);
  } finally {
    isProcessing = false;
    
    // Continue processing queue after a delay
    if (scrapingQueue.length > 0) {
      console.log(`Queue has ${scrapingQueue.length} remaining items. Processing next after delay.`);
      setTimeout(processQueue, RATE_LIMIT_DELAY);
    } else {
      console.log('Queue processing complete.');
    }
  }
}

// Create a browser instance once
let browser;
let browserInitializing = false;
let browserInitPromise = null;

async function initBrowser() {
  // If browser exists and is working, return it
  if (browser && browser.process() != null) {
    try {
      return browser;
    } catch (e) {
      console.log('Existing browser disconnected, launching new instance');
      browser = null;
    }
  }
  
  // If another initialization is in progress, wait for it
  if (browserInitializing && browserInitPromise) {
    console.log('Browser initialization already in progress, waiting...');
    try {
      return await browserInitPromise;
    } catch (error) {
      console.error('Error waiting for browser initialization:', error);
      // Continue with a new initialization
    }
  }
  
  // Start a new initialization
  browserInitializing = true;
  browserInitPromise = (async () => {
    try {
      console.log('Launching new browser instance optimized for Render environment');
    
      // Check if we're running on Render (common env variable on Render)
      const isRender = process.env.RENDER || process.env.RENDER_EXTERNAL_URL;
      
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-infobars',
        '--window-position=0,0',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--mute-audio'
      ];
      
      // Add specific optimizations for Render environment
      if (isRender) {
        args.push(
          '--disable-dev-tools',
          '--disable-software-rasterizer',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService',
          '--memory-pressure-off'
        );
      } else {
        // For local development, can use larger window size
        args.push('--window-size=1920,1080');
      }
      
      browser = await puppeteer.launch({
        headless: "new",
        args: args,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        timeout: 60000, // Set a more reasonable timeout for browser launch
        // Default timeout was 0 (infinite) which can cause issues on cloud environments
        ignoreHTTPSErrors: true,
        handleSIGINT: false, // Let our own handlers manage process signals
        handleSIGTERM: false,
        handleSIGHUP: false
      });
      
      // Handle browser disconnection
      browser.on('disconnected', () => {
        console.log('Browser disconnected. Will create a new instance on next request.');
        browser = null;
      });
      
      console.log('Browser instance successfully created');
      browserInitializing = false;
      return browser;
    } catch (error) {
      browserInitializing = false;
      console.error('Failed to launch browser:', error);
      throw error;
    }
  })();
  
  return browserInitPromise;
}

let browserPagePool = [];
const MAX_PAGES = 5;

async function getPage() {
  if (browserPagePool.length > 0) {
    const page = browserPagePool.pop();
    try {
      // Test if page is still usable
      await page.evaluate(() => true);
      return page;
    } catch (e) {
      console.log('Cached page no longer usable, creating new one');
    }
  }
  
  // Get or create browser instance
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();
  
  // Set page timeout to 0 (no timeout)
  page.setDefaultTimeout(0);
  
  // Rotate between desktop and mobile user agents
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
  ];
  
  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(randomUserAgent);
  
  // Set viewport - alternate between mobile and desktop
  if (randomUserAgent.includes('iPhone') || randomUserAgent.includes('Mobile')) {
    await page.setViewport({ width: 375, height: 667, isMobile: true });
  } else {
    await page.setViewport({ width: 1280, height: 800, isMobile: false });
  }
  
  // Only block image and video resources to speed up loading but allow CSS and scripts to execute properly
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.resourceType() === 'image' || request.resourceType() === 'media' || 
        request.resourceType() === 'font' || request.url().includes('analytics') || 
        request.url().includes('tracker')) {
      request.abort();
    } else {
      request.continue();
    }
  });

  // Add error handlers
  page.on('error', err => {
    console.error('Page error:', err);
  });

  page.on('pageerror', err => {
    console.error('Page error in browser context:', err);
  });
  
  return page;
}


function releasePage(page) {
  if (browserPagePool.length < MAX_PAGES) {
    browserPagePool.push(page);
  } else {
    page.close().catch(console.error);
  }
}

// Add to your scraper.js
function saveToFileCache(productId, data) {
  const cacheDir = path.join(__dirname, 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  
  // Save individual product cache
  fs.writeFileSync(
    path.join(cacheDir, `${productId}.json`), 
    JSON.stringify({timestamp: Date.now(), data})
  );
  
  // Regenerate the combined JSON after adding a new product
  generateCombinedProductsJSON();
}

// Add this function to generate a combined products JSON file

function generateCombinedProductsJSON() {
  const cacheDir = path.join(__dirname, 'cache');
  const combinedPath = path.join(__dirname, 'products.json');
  const allProducts = [];
  
  // Check if cache directory exists
  if (!fs.existsSync(cacheDir)) {
    console.log('Cache directory does not exist, creating it.');
    fs.mkdirSync(cacheDir);
    return; // No files to process
  }
  
  try {
    // Read all JSON files in the cache directory
    const files = fs.readdirSync(cacheDir).filter(file => file.endsWith('.json'));
    
    if (files.length === 0) {
      console.log('No product cache files found.');
      return;
    }
    
    console.log(`Found ${files.length} product files in cache.`);
    
    // Process each file and build the combined data
    for (const file of files) {
      try {
        const filePath = path.join(cacheDir, file);
        const rawData = fs.readFileSync(filePath, 'utf8');
        const productData = JSON.parse(rawData);
        
        // Extract product ID from filename (remove .json extension)
        const productId = path.basename(file, '.json');
        
        // Add to the array as a flat object (better for CSV conversion)
        allProducts.push({
          id: productId,
          lastUpdated: productData.timestamp,
          title: productData.data.data.title || '',
          brand: productData.data.data.brand || '',
          price: productData.data.data.price || '',
          availability: productData.data.data.availability || '',
          description: productData.data.data.description || '',
          images: (productData.data.data.images || []).join(','),
          availableSizes: (productData.data.data.availableSizes || []).join(',')
        });
      } catch (err) {
        console.error(`Error processing file ${file}:`, err);
      }
    }
    
    // Save the combined data
    fs.writeFileSync(
      combinedPath, 
      JSON.stringify({
        lastGenerated: Date.now(),
        productCount: allProducts.length,
        products: allProducts
      }, null, 2) // Add indentation for readability
    );
    
    console.log(`Successfully generated combined products JSON with ${allProducts.length} products.`);
    return combinedPath;
  } catch (err) {
    console.error('Error generating combined products JSON:', err);
  }
}

// Add an endpoint to manually regenerate the combined JSON
// This can be called via API rather than regenerating on every save
async function regenerateCombinedJSON() {
  return generateCombinedProductsJSON();
}

// Add this function to the top of your actualScrapeFunction to improve debugging
function logScrapingInfo(message, url) {
  console.log(`[${new Date().toISOString()}] [Scraping] ${message} - ${url}`);
}

function actualScrapeFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    let retries = 4; // Increase retries
    
    while (retries > 0) {
      try {
        logScrapingInfo(`Attempting to scrape (retry ${5-retries}/4)`, url);
        
        page = await getPage();
        
        // Random sleep before navigation to avoid detection patterns
        const randomSleep = Math.floor(Math.random() * 1000) + 500;
        await new Promise(r => setTimeout(r, randomSleep));
        
        logScrapingInfo("Setting up page with anti-detection measures", url);
        
        // First try with JavaScript enabled (to handle dynamic websites better)
        await page.setJavaScriptEnabled(true);
        
        // Add more evasion techniques
        await page.evaluateOnNewDocument(() => {
          // Overwrite the navigator properties to avoid detection
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
          });
          
          // Create a fake plugins array
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
          
          // Create a fake languages array
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });
          
          // Override permissions
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
              Promise.resolve({ state: Notification.permission }) :
              originalQuery(parameters)
          );
          
          // Prevent detection of headless mode
          window.chrome = {
            runtime: {},
          };
        });
        
        // Set a shorter hard timeout for the entire scraping operation
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Internal scraper timeout after 60s'));
          }, 60000);
        });
        
        // Add some randomness to navigation options
        const waitUntilOptions = ['domcontentloaded', 'networkidle2'];
        const selectedWaitOption = waitUntilOptions[Math.floor(Math.random() * waitUntilOptions.length)];
        
        logScrapingInfo(`Navigation started with ${selectedWaitOption} wait option`, url);
        
        // Wrap navigation in a race with timeout
        const navigationPromise = page.goto(url, { 
          waitUntil: selectedWaitOption, 
          timeout: 20000 // 20 second timeout for navigation
        });
        
        const response = await Promise.race([navigationPromise, timeoutPromise]);
        
        if (!response) {
          throw new Error('No response received from page');
        }
        
        // Check status code
        if (response.status() >= 400) {
          throw new Error(`Received HTTP ${response.status()} status code`);
        }
        
        logScrapingInfo("Page loaded successfully, waiting for content", url);
        
        // Wait a bit for JavaScript to execute and check for captchas/blocks
        await page.waitForTimeout(1000);
        
        // Simulate more minimal human-like behavior to reduce execution time
        await page.evaluate(() => {
          window.scrollBy(0, 500);
          setTimeout(() => window.scrollBy(0, 300), 300);
        });
        
        await page.waitForTimeout(500);
        
        // Check if page contains content
        const pageContent = await page.content();
        if (!pageContent.includes('Myntra') && !pageContent.includes('product')) {
          throw new Error('Page does not contain expected content');
        }
        
        // Check for common bot detection patterns
        const title = await page.title();
        if (title.includes('Robot') || title.includes('Captcha') || title.includes('Blocked')) {
          throw new Error('Bot protection detected in page title');
        }
        
        logScrapingInfo("Extracting product data", url);
        
        // Simplify data extraction to focus only on essential fields
        const productData = await page.evaluate(() => {
          const getTextContent = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };
          
          return {
            title: document.title.replace(' | Myntra', '').trim() || 
                   getTextContent('.pdp-name') || 
                   getTextContent('h1.title') || 
                   "Unknown Product",
            brand: getTextContent('.pdp-title .pdp-name') || 
                   getTextContent('.brand-name') || 
                   getTextContent('.pdp-title') ||
                   "Unknown Brand",
            price: getTextContent('.pdp-price') || 
                   getTextContent('.pdp-discount-container') || 
                   getTextContent('.pdp-mrp') || 
                   getTextContent('.price') || "N/A",
            description: getTextContent('.pdp-product-description') || "",
            images: [],
            availability: document.body.textContent.includes('OUT OF STOCK') ? 'out_of_stock' : 'in_stock'
          };
        });
        
        logScrapingInfo("Successfully extracted product data, cleaning up", url);
        
        // Release the page back to the pool
        releasePage(page);
        page = null;
        
        // Return success
        resolve({
          success: true,
          data: productData
        });
        
        // Exit retry loop on success
        break;
      } catch (error) {
        console.error(`Error scraping attempt ${5-retries}/4: ${error.message}`);
        
        // Clean up page on error
        if (page) {
          try {
            await page.close().catch(() => {});
            page = null;
          } catch (e) {
            console.error('Error closing page:', e);
          }
        }
        
        retries--;
        
        // If we have retries left, wait before trying again with increasing delays
        if (retries > 0) {
          const waitTime = (5 - retries) * 3000; // Progressive backoff
          logScrapingInfo(`Retrying in ${waitTime/1000} seconds (${retries} attempts left)`, url);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          // All retries failed, return error response
          resolve({
            success: false,
            error: 'Failed to scrape product data after multiple attempts',
            details: error.message || 'Unknown error'
          });
        }
      }
    }
  });
}

// Add this helper function for human-like behavior
async function simulateHumanBehavior(page) {
  try {
    // Random scrolling
    await page.evaluate(() => {
      return new Promise((resolve) => {
        // Random number of scrolls between 2 and 5
        const scrollCount = Math.floor(Math.random() * 4) + 2;
        const scrollHeight = document.body.scrollHeight;
        let currentScroll = 0;
        let scrollStep = 0;
        
        const scrollInterval = setInterval(() => {
          // Random scroll step between 100 and 300 pixels
          scrollStep = Math.floor(Math.random() * 200) + 100;
          currentScroll += scrollStep;
          
          // Scroll down
          window.scrollBy(0, scrollStep);
          
          // Add some random mouse movements (this won't actually move the mouse but can help)
          if (Math.random() > 0.7) {
            const mouseEvent = new MouseEvent('mousemove', {
              'view': window,
              'bubbles': true,
              'cancelable': true,
              'clientX': Math.random() * window.innerWidth,
              'clientY': Math.random() * window.innerHeight
            });
            document.dispatchEvent(mouseEvent);
          }
          
          // If we've scrolled enough or reached bottom, start scrolling back up
          if (currentScroll >= scrollHeight * 0.7 || scrollCount <= 0) {
            clearInterval(scrollInterval);
            
            // Random timeout before scrolling back up
            setTimeout(() => {
              window.scrollTo(0, 0);
              resolve();
            }, Math.random() * 1000 + 500);
          }
        }, Math.random() * 500 + 300); // Random interval between scrolls
      });
    });
    
    // Random wait after scrolling
    await page.waitForTimeout(Math.random() * 1000 + 500);
    
    // Sometimes click on a product image (simulates user exploring the product)
    if (Math.random() > 0.5) {
      await page.evaluate(() => {
        const productImages = document.querySelectorAll('.image-grid-image, .image-grid-imageV2, .common-image-container img');
        if (productImages && productImages.length > 0) {
          const randomIndex = Math.floor(Math.random() * productImages.length);
          productImages[randomIndex].click();
        }
      });
      
      // Wait after clicking
      await page.waitForTimeout(Math.random() * 1000 + 500);
    }
    
  } catch (error) {
    console.error('Error during human behavior simulation:', error);
    // Continue even if simulation fails
  }
}

// Replace your existing checkAvailability function with this improved version

function checkAvailability() {
  try {
    // FIRST CHECK: Look for the ADD TO BAG div element pattern specific to Myntra
    // This is the most reliable indicator a product is in stock
    const addToBagElements = document.querySelectorAll('.pdp-add-to-bag:not(.pdp-out-of-stock)');
    if (addToBagElements && addToBagElements.length > 0) {
      console.log("Found ADD TO BAG element - product is in stock");
      return 'in_stock';
    }
    
    // SECOND CHECK: Check for specific out-of-stock indicators used by Myntra
    const outOfStockElements = document.querySelectorAll('.size-buttons-out-of-stock, .pdp-out-of-stock, .soldOutP');
    if (outOfStockElements && outOfStockElements.length > 0) {
      console.log("Found out of stock indicator elements");
      return 'out_of_stock';
    }
    
    // THIRD CHECK: Check text content for "out of stock" phrases
    // Use parentElement check to target only text directly in these elements
    const stockStatusElements = document.querySelectorAll('.pdp-add-to-bag, .pdp-action-container, .size-buttons-container');
    for (const element of stockStatusElements) {
      if (element.textContent.toLowerCase().includes('out of stock') || 
          element.textContent.toLowerCase().includes('sold out')) {
        console.log("Found 'out of stock' text in relevant element");
        return 'out_of_stock';
      }
    }
    
    // FOURTH CHECK: Check if all size buttons are marked as out of stock
    const sizeElements = document.querySelectorAll('.size-buttons-unified-size');
    if (sizeElements && sizeElements.length > 0) {
      const allSizesOutOfStock = Array.from(sizeElements).every(el => 
        el.classList.contains('size-buttons-unified-size-out-of-stock') || 
        el.classList.contains('size-buttons-unified-size-strike-hide')
      );
      
      if (allSizesOutOfStock) {
        console.log("All size buttons are marked as out of stock");
        return 'out_of_stock';
      } else {
        console.log("Found available sizes - product is in stock");
        return 'in_stock';
      }
    }
    
    // FIFTH CHECK: Final check for any ADD TO BAG text in relevant containers
    const anyBagText = document.body.textContent.includes('ADD TO BAG');
    if (anyBagText && !document.body.textContent.includes('OUT OF STOCK')) {
      console.log("Found ADD TO BAG text without OUT OF STOCK text");
      return 'in_stock';
    }
    
    // Default to in_stock for Myntra (as they typically don't show unavailable products)
    console.log("No definitive indicators found, defaulting to in_stock");
    return 'in_stock';
  } catch (e) {
    console.error('Error checking availability:', e);
    return 'in_stock'; // Default to in_stock on error
  }
}

// Update the scrapeMyntraProduct function in scraper.js
async function scrapeMyntraProduct(url) {
  // Check if the input is just an ID number
  if (/^\d+$/.test(url)) {
    // Convert numeric ID to a proper Myntra URL format
    // Try both formats since we don't know which is correct
    console.log(`Received numeric ID: ${url}, converting to URL`);
    
    // For format /product-name/brand/product-id
    url = `https://www.myntra.com/${url}`;
  } else if (!url.startsWith('http')) {
    // If URL doesn't start with http, assume it's a path and prepend Myntra domain
    url = `https://www.myntra.com/${url}`;
  }
  
  console.log(`Final URL being processed: ${url}`);
  
  // Extract product ID from URL (last segment)
  const urlSegments = url.split('/');
  const productId = urlSegments[urlSegments.length - 1];
  
  // Check if in cache and not expired
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // If not in cache or expired, scrape and then cache
  return new Promise((resolve, reject) => {
    actualScrapeFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Add Amazon scraping implementation
async function scrapeAmazonProduct(url) {
  console.log(`Scraping Amazon product: ${url}`);
  
  // Extract ASIN from URL if needed
  let productId = 'unknown';
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (asinMatch) {
    productId = asinMatch[1];
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Amazon product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeAmazonFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Amazon scraping implementation
function actualScrapeAmazonFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      // Set user agent to avoid bot detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      console.log(`Navigating to Amazon URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Amazon page: ${response ? response.status() : 'No response'}`);
      }
      
      // Check for CAPTCHA page
      const pageTitle = await page.title();
      if (pageTitle.includes('Robot') || pageTitle.includes('CAPTCHA')) {
        throw new Error('Amazon bot protection detected. Please try again later.');
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('#productTitle')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('#bylineInfo')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('.a-price .a-offscreen')?.textContent.trim() || 'N/A',
          description: document.querySelector('#productDescription')?.textContent.trim() || 
                       document.querySelector('#feature-bullets')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('#altImages img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => {
              const src = img.dataset.oldHires || img.src;
              return src.replace(/._[^.]+\./, '.'); // Convert to full-size image
            })
            .filter(url => url && !url.includes('spinner') && !url.includes('play-button'));
        }
        
        // Get main image if altImages is empty
        if (data.images.length === 0) {
          const mainImage = document.querySelector('#landingImage, #imgBlkFront');
          if (mainImage) {
            const src = mainImage.dataset.oldHires || mainImage.src;
            data.images.push(src);
          }
        }
        
        // Check availability
        const availabilityText = document.querySelector('#availability')?.textContent.trim() || '';
        data.availability = availabilityText.toLowerCase().includes('in stock') ? 'in_stock' : 'out_of_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('#variation_size_name .a-size-base:not(.a-color-secondary)');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Amazon product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Amazon:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Amazon product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Add Flipkart scraping implementation
async function scrapeFlipkartProduct(url) {
  console.log(`Scraping Flipkart product: ${url}`);
  
  // Extract product ID from URL
  let productId = 'unknown';
  const pidMatch = url.match(/pid=([^&]+)/);
  if (pidMatch) {
    productId = pidMatch[1];
  } else {
    // Alternative pattern
    const altMatch = url.match(/\/p\/([^/]+)/);
    if (altMatch) {
      productId = altMatch[1];
    }
  }
  
  // Check cache like the Myntra implementation
  if (productCache.has(productId)) {
    const cachedData = productCache.get(productId);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`Returning cached data for Flipkart product ${productId}`);
      return Promise.resolve(cachedData.data);
    }
  }
  
  // Similar pattern to scrapeMyntraProduct
  return new Promise((resolve, reject) => {
    actualScrapeFlipkartFunction(url)
      .then(result => {
        if (result.success) {
          productCache.set(productId, {
            timestamp: Date.now(),
            data: result
          });
          saveToFileCache(productId, result);
        }
        resolve(result);
      })
      .catch(reject);
  });
}

// Flipkart scraping implementation
function actualScrapeFlipkartFunction(url) {
  return new Promise(async (resolve, reject) => {
    let page = null;
    
    try {
      page = await getPage();
      
      console.log(`Navigating to Flipkart URL: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      if (!response || response.status() !== 200) {
        throw new Error(`Failed to load Flipkart page: ${response ? response.status() : 'No response'}`);
      }
      
      // Extract product data
      const productData = await page.evaluate(() => {
        const data = {
          title: document.querySelector('h1.yhB1nd')?.textContent.trim() || 
                 document.querySelector('h1.B_NuCI')?.textContent.trim() || 'Unknown Product',
          brand: document.querySelector('span.G6XhRU')?.textContent.trim() || 'Unknown Brand',
          price: document.querySelector('._30jeq3')?.textContent.trim() || 'N/A',
          description: document.querySelector('._1mXcCf')?.textContent.trim() || '',
          images: [],
          availableSizes: []
        };
        
        // Get all image URLs
        const imageElements = document.querySelectorAll('._2amPTt img, .CXW8mj img, ._3nMexc img');
        if (imageElements && imageElements.length > 0) {
          data.images = Array.from(imageElements)
            .map(img => img.src)
            .filter(url => url && url.includes('flipkart') && !url.includes('placeholder'));
        }
        
        // Check availability
        const outOfStock = document.querySelector('._16FRp0');
        data.availability = outOfStock ? 'out_of_stock' : 'in_stock';
        
        // Extract sizes if available (for clothing items)
        const sizeElements = document.querySelectorAll('._1fGeJ5._2UVyXR._31hAvz');
        if (sizeElements && sizeElements.length > 0) {
          data.availableSizes = Array.from(sizeElements)
            .map(el => el.textContent.trim())
            .filter(size => size);
        }
        
        return data;
      });
      
      console.log('Successfully scraped Flipkart product data');
      
      resolve({
        success: true,
        data: productData
      });
    } catch (error) {
      console.error('Error scraping Flipkart:', error.message);
      
      resolve({
        success: false,
        error: 'Failed to scrape Flipkart product data',
        details: error.message || 'Unknown error'
      });
    } finally {
      if (page) releasePage(page);
    }
  });
}

// Add this function to help manage browser resources
async function closeBrowsers() {
  try {
    console.log('Closing all browser instances...');
    if (browser) {
      await browser.close().catch(err => console.error('Error closing main browser:', err));
      browser = null;
    }
    
    // Also close any browsers in the pool
    for (const pooledBrowser of browserPool) {
      try {
        await pooledBrowser.close().catch(err => console.error('Error closing pooled browser:', err));
      } catch (e) {
        console.error('Error closing pooled browser:', e);
      }
    }
    
    // Clear the pool
    browserPool.length = 0;
    
    console.log('All browser instances closed');
  } catch (error) {
    console.error('Error closing browsers:', error);
  }
}

// Update the exports
module.exports = {
  scrapeMyntraProduct,
  scrapeAmazonProduct,
  scrapeFlipkartProduct,
  regenerateCombinedJSON,
  closeBrowsers,
  initBrowser // Add this
};

// Add an event handler for uncaught exceptions to clean up resources
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await closeBrowsers();
  // Don't exit process as this might be in a container environment
});

// Add an event handler for unhandled rejections to clean up resources
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await closeBrowsers();
  // Don't exit process as this might be in a container environment
});

