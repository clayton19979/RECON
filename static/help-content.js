/* Help topics — the content behind the Help screen, the F1 overlay, and the
   per-screen "?" buttons. Plain data, no build step: edit and refresh.

   Every topic is:
     id       unique kebab-case key, used by `related` and by deep links
     title    what the topic is called in the list
     view     the rail screen this topic starts on -- must be a real
              data-view on a .rail-item, because the topic's "Take me there"
              button calls showView() with it
     aliases  what someone might actually type. This is the part that makes
              search work for a new service writer: they search for "the
              customer's bringing the old alternator back", not for "Cores &
              Returns". Aliases cost nothing and are the difference between
              finding a feature and concluding the app can't do it.
     summary  one sentence: what this is, in plain shop English
     steps    how to actually do it, short enough to follow from memory
     related  ids of topics someone reading this one usually needs next

   Search matches title, aliases, summary and steps, so a word that appears
   anywhere in a topic finds it -- aliases only need to carry the words the
   text itself never says. */

const HELP_TOPICS = [

  /* ── Getting oriented ─────────────────────────────────────────── */

  {
    id: "getting-started",
    title: "What RECON is, and how a day runs",
    view: "vehicles",
    aliases: ["new here", "first day", "how do i start", "overview", "basics", "training", "where do i begin"],
    summary: "RECON tracks every vehicle in the shop from the day it lands to the day it's done, plus what was spent getting it there.",
    steps: [
      "Vehicles is the main screen — every car currently in the shop is a row.",
      "Click a row to open that vehicle: its repair order, parts, labor, cost and notes.",
      "Set 'Working as' in the top right to your own name so your work is recorded under you.",
      "The other screens hang off that: Customers is who owns the cars, Accounts Payable is what vendors billed, Reports is what it all added up to.",
    ],
    related: ["recon-vs-we-owe", "working-as", "vehicles-board"],
  },

  {
    id: "recon-vs-we-owe",
    title: "Recon vehicles vs. We-Owe promises",
    view: "vehicles",
    aliases: ["we owe", "weowe", "due bill", "we-owe promise", "owe the customer", "promised the customer", "recon", "reconditioning", "lot car", "customer car", "retail", "what's the difference"],
    summary: "Two kinds of ticket live on the same board: recon work on the lot's own cars, and we-owe promises made to a customer who already bought one.",
    steps: [
      "Recon — a vehicle the lot owns, being prepped for sale. Cost matters because it comes off the profit.",
      "We-Owe — something promised to a customer at delivery: a second key, a missing mirror, a repair agreed to on the spot.",
      "Use the Recon / We-Owe chips above the table to see one kind at a time.",
      "A we-owe ticket has extra fields a recon one doesn't: what was promised, a target date, and whether it's been fulfilled or waived.",
    ],
    related: ["add-recon-vehicle", "add-we-owe", "we-owe-close-out"],
  },

  {
    id: "working-as",
    title: "Setting who you are",
    view: "vehicles",
    aliases: ["working as", "log in", "login", "sign in", "who am i", "my name", "user", "change user", "it says unspecified"],
    summary: "The 'Working as' picker in the top right stamps your name on the work you do — there are no passwords, you just pick yourself.",
    steps: [
      "Click the 'Working as' dropdown in the top-right corner.",
      "Pick your name. If it isn't listed, someone needs to add you under Staff.",
      "Your choice sticks on this computer, so you only do it once.",
      "Notes, status changes and posted invoices record whoever is selected — leaving it on Unspecified makes the history less useful later.",
    ],
    related: ["add-staff", "vehicle-activity"],
  },

  {
    id: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    view: "vehicles",
    aliases: ["shortcuts", "hotkeys", "keys", "faster", "without the mouse", "keyboard"],
    summary: "The Vehicles board and Tasks list are both fully keyboard-driven.",
    steps: [
      "Press ? anywhere to see the full list.",
      "/ jumps to the search box; just typing letters on the board starts a search too.",
      "Up and down move the highlighted row, Enter opens it, Space selects it.",
      "Shift+click selects a range of rows, Ctrl+click adds or removes one.",
      "Esc backs out: it closes dialogs, then clears search, then clears the selection.",
    ],
    related: ["vehicles-board", "find-a-vehicle"],
  },

  /* ── The Vehicles board ───────────────────────────────────────── */

  {
    id: "vehicles-board",
    title: "Reading the Vehicles board",
    view: "vehicles",
    aliases: ["main screen", "the list", "board", "home screen", "all cars", "columns", "what do the columns mean"],
    summary: "One row per vehicle in the shop, with the numbers that tell you which ones need attention today.",
    steps: [
      "The five cards across the top count exactly the rows shown below them — filter the board and every number follows.",
      "Waiting on Parts, Stalled and Over Quote are clickable: clicking one filters the board down to what it counts.",
      "The chips below switch between All, Recon, We-Owe and History (finished work).",
      "Click any column heading to sort by it.",
      "'Reset view' appears once you've filtered, and puts everything back.",
    ],
    related: ["idle-and-age", "over-quote", "find-a-vehicle", "send-to-history"],
  },

  {
    id: "find-a-vehicle",
    title: "Finding a vehicle",
    view: "vehicles",
    aliases: ["search", "look up a car", "find a car", "stock number", "stock #", "vin", "find by customer", "where is the car"],
    summary: "The search box at the top finds vehicles by stock number, VIN, or customer name.",
    steps: [
      "Click the search box at the top of the screen, or press /.",
      "Type any part of a stock number, VIN, or the customer's name.",
      "The board filters as you type and switches to the Vehicles screen if you were somewhere else.",
      "Press Esc or click the × to clear it.",
      "Finished vehicles are hidden by default — click the History chip to search those too.",
    ],
    related: ["vehicles-board", "find-a-customer", "send-to-history"],
  },

  {
    id: "idle-and-age",
    title: "What Age and Idle mean",
    view: "vehicles",
    aliases: ["age", "idle", "days", "sitting", "stalled", "how long", "nothing happening", "6 days", "stale"],
    summary: "Age is how long the vehicle has been in the shop; Idle is how long since anyone actually touched it.",
    steps: [
      "Age counts from the date the vehicle came in — a long age isn't automatically a problem.",
      "Idle counts from the last thing that happened on its repair order. That's the number that finds forgotten cars.",
      "Anything idle more than six days counts as Stalled and shows on the Stalled card.",
      "Click the Stalled card to see just those, then select them and use 'Make Tasks' to write down what each one needs.",
    ],
    related: ["vehicles-board", "tasks-from-the-board"],
  },

  {
    id: "over-quote",
    title: "Quoted vs. actual cost",
    view: "vehicles",
    aliases: ["over quote", "over estimate", "quoted", "actual", "cost", "went over", "budget", "how much have we spent"],
    summary: "Quoted is what the job was estimated at; actual is what has really been spent so far on received parts and labor.",
    steps: [
      "On the board, the Quoted and Cost columns sit side by side so a gap is visible at a glance.",
      "The Over Quote card counts vehicles where actual has passed quoted — click it to see only those.",
      "Inside a vehicle, the 'This Ticket' card shows both numbers and the difference between them.",
      "Only received parts count toward actual — parts that are merely ordered haven't cost anything yet.",
    ],
    related: ["receive-parts", "add-parts-and-labor", "vehicle-totals"],
  },

  /* ── Starting work ────────────────────────────────────────────── */

  {
    id: "add-recon-vehicle",
    title: "Adding a recon vehicle",
    view: "vehicles",
    aliases: ["new car", "add a car", "new vehicle", "add vehicle", "lot car", "put a car in", "new recon", "decode vin", "decode plate", "vin lookup", "auction car", "trade in"],
    summary: "Puts one of the lot's own vehicles on the board so its reconditioning can be tracked.",
    steps: [
      "On the Vehicles screen, click 'Recon Vehicle' in the top right.",
      "Enter the stock number — that's the only thing you have to know.",
      "Type the VIN and click 'Decode VIN' to fill in year, make, model and engine automatically. If you only have the plate, enter it with the state and click 'Decode Plate' instead.",
      "Fill in whatever else you have — trim, color, mileage, purchase price, where it came from, the date acquired.",
      "Click 'Save Recon Vehicle'. It appears on the board immediately.",
      "No repair order exists yet — open the vehicle and start one when work actually begins.",
    ],
    related: ["start-repair-order", "recon-vs-we-owe"],
  },

  {
    id: "add-we-owe",
    title: "Writing a we-owe promise",
    view: "vehicles",
    aliases: ["we owe", "due bill", "promised", "owe the customer", "second key", "add we owe", "customer was promised"],
    summary: "Records something promised to a customer who has already taken delivery, so it doesn't get forgotten.",
    steps: [
      "On the Vehicles screen, click 'We-Owe Promise' in the top right.",
      "Pick or add the customer and their vehicle.",
      "Describe what was promised and set a target date.",
      "Save — it lands on the board alongside recon work, tagged We-Owe.",
    ],
    related: ["recon-vs-we-owe", "we-owe-close-out", "take-a-deposit"],
  },

  {
    id: "start-repair-order",
    title: "Starting a repair order",
    view: "vehicles",
    aliases: ["ro", "write an ro", "repair order", "open a ticket", "start a ticket", "new ro", "work order", "ticket"],
    summary: "A vehicle sits on the board without a repair order until work actually begins on it.",
    steps: [
      "Open the vehicle from the board.",
      "In the 'No repair order yet' card, type what's being done — the concern.",
      "Click 'Start Repair Order'. It gets an RO number.",
      "The Parts & Labor grid appears; build the estimate there.",
      "One vehicle can have several repair orders over time — past ones are listed under Order History.",
    ],
    related: ["add-parts-and-labor", "assign-tech-and-advisor", "vehicle-status"],
  },

  {
    id: "add-parts-and-labor",
    title: "Building the estimate",
    view: "vehicles",
    aliases: ["estimate", "add a part", "add labor", "add job", "quote", "line items", "parts and labor", "price", "markup"],
    summary: "The Parts & Labor grid on a repair order is the estimate — everything is entered at cost, with no markup.",
    steps: [
      "Open the vehicle and find the Parts & Labor card.",
      "'+ Add Job' groups related work; '+ Part' and '+ Labor' add lines under it.",
      "Every field saves itself as you type — there's no Save button, and the card says so when it's saving.",
      "The totals under 'This Ticket' update as you go.",
    ],
    related: ["order-parts", "receive-parts", "over-quote"],
  },

  {
    id: "order-parts",
    title: "Marking parts ordered",
    view: "vehicles",
    aliases: ["order parts", "on order", "ordered", "purchase order", "po", "did it order the part", "does this call the vendor"],
    summary: "Flags the quoted parts on a ticket as ordered — it does not place an order with a vendor.",
    steps: [
      "Open the vehicle and click 'Mark Parts Ordered' on the Parts & Labor card.",
      "Every quoted part line on that ticket flips to ordered.",
      "This is bookkeeping only. Call, fax or order from the vendor exactly as you always have.",
      "The vehicle now counts on the board's 'Waiting on Parts' card until those parts are received.",
    ],
    related: ["receive-parts", "add-parts-and-labor", "vehicles-board"],
  },

  {
    id: "receive-parts",
    title: "Receiving parts",
    view: "vehicles",
    aliases: ["receive", "parts came in", "parts arrived", "check in parts", "got the parts", "invoice came with the parts", "receive selected"],
    summary: "Receiving a part records the vendor's invoice for it — which is why a part only counts toward actual cost once it's received.",
    steps: [
      "Open the vehicle, tick the part lines that arrived, and click 'Receive Selected'.",
      "Enter the vendor and invoice number from the paperwork that came with the parts.",
      "That posts a real accounts-payable record against the repair order — you don't have to enter it again on the Accounts Payable screen.",
      "The lines flip to received and the cost lands on the ticket's actual total.",
    ],
    related: ["order-parts", "post-vendor-invoice", "over-quote"],
  },

  {
    id: "assign-tech-and-advisor",
    title: "Assigning a technician or advisor",
    view: "vehicles",
    aliases: ["assign", "tech", "technician", "advisor", "service writer", "who's working on it", "give it to someone"],
    summary: "Sets who is doing the work and who is handling the customer on this repair order.",
    steps: [
      "Open the vehicle and click 'Assign' near the top right.",
      "Pick a Technician, an Advisor, or both, then Save.",
      "The technician shows on the board so you can see everyone's load at a glance.",
      "Only active staff appear in the lists — add people under Staff first.",
    ],
    related: ["add-staff", "productivity-report", "vehicle-status"],
  },

  {
    id: "vehicle-status",
    title: "Changing a vehicle's status",
    view: "vehicles",
    aliases: ["status", "change status", "in progress", "waiting", "done", "complete", "move it along", "stage"],
    summary: "The status picker at the top of a vehicle moves it through the shop's stages.",
    steps: [
      "Open the vehicle and use the status dropdown at the top right.",
      "The board's Status filter lets you see everything sitting at one stage.",
      "Changing status counts as activity, so it resets the vehicle's Idle clock.",
    ],
    related: ["idle-and-age", "send-to-history", "vehicles-board"],
  },

  /* ── While the car is here ────────────────────────────────────── */

  {
    id: "vehicle-notes",
    title: "Leaving notes on a vehicle",
    view: "vehicles",
    aliases: ["note", "notes", "comment", "write it down", "internal note", "customer note", "log a call"],
    summary: "Notes live in the Details drawer and are marked either Internal or Customer.",
    steps: [
      "Open the vehicle and find the Notes card in the Details drawer on the right.",
      "Choose Internal (shop-only) or Customer, type the note, and click Add Note.",
      "Notes are stamped with who wrote them and when.",
      "Adding a note counts as activity, so it resets the vehicle's Idle clock.",
    ],
    related: ["vehicle-activity", "working-as", "idle-and-age"],
  },

  {
    id: "vehicle-activity",
    title: "Seeing what happened to a vehicle",
    view: "vehicles",
    aliases: ["history", "activity", "who changed this", "audit", "what happened", "trail", "log"],
    summary: "The Activity card records every change made to a vehicle, and who made it.",
    steps: [
      "Open the vehicle and scroll the Details drawer to the Activity card.",
      "Entries are newest first, each with the person who made the change.",
      "'Order History' just above it lists every repair order the vehicle has ever had.",
    ],
    related: ["vehicle-notes", "working-as", "vehicle-totals"],
  },

  {
    id: "promised-time",
    title: "Recording date in, odometer and promised time",
    view: "vehicles",
    aliases: ["promised", "promise time", "when will it be ready", "date in", "odometer", "mileage", "timing"],
    summary: "The Timing card holds the date the vehicle arrived, its odometer reading, and when it's promised back.",
    steps: [
      "Open the vehicle and find the Timing card in the Details drawer.",
      "Fill in Date in, Odometer in, and Promised, then click Save.",
      "Date in is what the board's Age column counts from.",
    ],
    related: ["idle-and-age", "print-ticket"],
  },

  {
    id: "vehicle-totals",
    title: "This ticket vs. the whole vehicle",
    view: "vehicles",
    aliases: ["total", "totals", "all tickets", "what have we got in it", "whole cost", "two different numbers"],
    summary: "There are two cost totals on a vehicle page, and they answer different questions.",
    steps: [
      "'This Ticket' in the main column is the current repair order only.",
      "'Vehicle Total — All Tickets' in the Details drawer adds up every repair order the vehicle has ever had.",
      "For a recon car that's been back more than once, the second number is what the lot actually has in it.",
    ],
    related: ["over-quote", "vehicle-activity"],
  },

  {
    id: "print-ticket",
    title: "Printing a ticket",
    view: "vehicles",
    aliases: ["print", "hard copy", "paper", "print the ro", "shop copy", "hang it on the mirror"],
    summary: "Prints the repair order for the shop or the customer, on letterhead.",
    steps: [
      "Open the vehicle and click 'Print Ticket' at the top right.",
      "Your browser's print dialog opens with the ticket formatted for paper.",
    ],
    related: ["start-repair-order", "export-and-print-reports"],
  },

  {
    id: "take-a-deposit",
    title: "Taking a customer payment on a we-owe",
    view: "vehicles",
    aliases: ["payment", "deposit", "customer paid", "took money", "collected", "paid cash", "take payment"],
    summary: "Records money the customer has put down against a we-owe promise.",
    steps: [
      "Open the we-owe vehicle and find the Customer Deposits card in the Details drawer.",
      "Click 'Take Payment', enter the amount and how they paid, and save.",
      "Payments are listed under the card and totalled, so what's still owed is always visible.",
    ],
    related: ["add-we-owe", "we-owe-close-out"],
  },

  {
    id: "we-owe-close-out",
    title: "Closing out a we-owe",
    view: "vehicles",
    aliases: ["fulfilled", "waived", "we owe done", "took care of it", "customer didn't want it", "close the we owe"],
    summary: "A we-owe ends one of two ways: fulfilled once you've done it, or waived if the customer let it go.",
    steps: [
      "Open the we-owe vehicle and find the We-Owe card in the Details drawer.",
      "Set Status to Fulfilled once the promise has been kept, or Waived if the customer decided against it, then Save.",
      "Send the vehicle to History afterwards to take it off the working board.",
    ],
    related: ["add-we-owe", "send-to-history", "take-a-deposit"],
  },

  /* ── Finishing and undoing ────────────────────────────────────── */

  {
    id: "send-to-history",
    title: "Sending a vehicle to History",
    view: "vehicles",
    aliases: ["archive", "done", "finished", "close it out", "get it off the board", "history", "completed", "sold"],
    summary: "History is where finished vehicles go — off the working board, but nothing is deleted.",
    steps: [
      "Open the vehicle and click 'Send to History', or select several rows on the board and use 'Send Selected to History'.",
      "Archived vehicles become read-only and stop showing in the default board.",
      "Click the History chip to see them.",
      "Open one and click 'Reopen' if work starts up again.",
    ],
    related: ["vehicles-board", "void-vs-delete", "we-owe-close-out"],
  },

  {
    id: "void-vs-delete",
    title: "Void a ticket vs. delete a vehicle",
    view: "vehicles",
    aliases: ["void", "delete", "remove", "cancel", "mistake", "wrong car", "undo", "get rid of it", "duplicate"],
    summary: "Void cancels a repair order but keeps the record; Delete removes the vehicle entirely and can't be undone.",
    steps: [
      "Void Ticket — use when the repair order shouldn't have been written, or was written on the wrong car. The vehicle stays, the ticket is cancelled and still visible.",
      "Delete — use only for a vehicle entered by mistake that has no real history. It's gone for good.",
      "If the work simply finished, neither of these is what you want — send it to History instead.",
      "When in doubt, void. A voided ticket can be explained later; a deleted vehicle can't be recovered.",
    ],
    related: ["send-to-history", "restore-a-backup"],
  },

  /* ── Customers ────────────────────────────────────────────────── */

  {
    id: "find-a-customer",
    title: "Looking up a customer",
    view: "customers",
    aliases: ["customer", "find a customer", "phone number", "address", "who owns this car", "contact", "rolodex", "email"],
    summary: "The Customers screen is everyone the shop has written a ticket for, with their vehicles and repair orders.",
    steps: [
      "Open Customers from the left rail.",
      "Search by name, phone, email or city.",
      "The row shows how many vehicles and repair orders they have, and when they were last in.",
      "Click a row to expand it and get to their vehicles.",
    ],
    related: ["add-customer-vehicle", "find-a-vehicle", "edit-customer-info"],
  },

  {
    id: "edit-customer-info",
    title: "Fixing a customer's details",
    view: "vehicles",
    aliases: ["edit customer", "wrong phone", "change address", "update contact", "moved", "new number", "typo"],
    summary: "Customer details can be corrected from the vehicle you're already looking at.",
    steps: [
      "Open any of their vehicles.",
      "In the Details drawer, click 'Edit Customer' on the Customer Info card.",
      "Phone numbers are reformatted to one standard shape automatically, so type them however you like.",
    ],
    related: ["find-a-customer", "add-customer-vehicle"],
  },

  {
    id: "add-customer-vehicle",
    title: "Adding another vehicle for a customer",
    view: "vehicles",
    aliases: ["second car", "another vehicle", "his wife's car", "add a car to a customer", "other vehicles", "same customer"],
    summary: "Puts a second (or third) vehicle on file under a customer you already have.",
    steps: [
      "Open one of that customer's vehicles.",
      "In the Details drawer, find the 'Customer's Other Vehicles' card.",
      "Click '+ Add Vehicle' and enter the new one — no need to re-enter the customer.",
      "Their other vehicles are listed on the same card, one click away.",
    ],
    related: ["find-a-customer", "edit-customer-info"],
  },

  /* ── Money ────────────────────────────────────────────────────── */

  {
    id: "post-vendor-invoice",
    title: "Posting a vendor invoice",
    view: "accounting",
    aliases: ["invoice", "bill", "vendor bill", "ap", "accounts payable", "enter an invoice", "worldpac", "napa", "parts bill"],
    summary: "Records what a vendor billed, against the repair order the parts were for.",
    steps: [
      "Open Accounts Payable and use the 'Post Vendor Invoice' form.",
      "Pick the vendor, type the invoice number, and choose the repair order it belongs to.",
      "Add a line per item with quantity and cost, then enter tax. Subtotal and total calculate themselves.",
      "Click Post Invoice.",
      "If you're receiving parts that just arrived, do it from the vehicle's ticket instead — that posts the invoice for you.",
    ],
    related: ["receive-parts", "invoice-approval", "manage-vendors"],
  },

  {
    id: "invoice-approval",
    title: "Why an invoice was held for review",
    view: "accounting",
    aliases: ["held", "approval", "over 500", "pending", "why didn't it post", "manager approval", "on hold", "review"],
    summary: "Invoices are held only when something about them doesn't add up — the old $500 approval limit is gone.",
    steps: [
      "There is no longer a dollar limit. An invoice of any size posts straight through.",
      "An invoice is held when the vendor name doesn't match one you've set up, when that invoice number was already posted, when the line items don't add up to the total, or when you'd be receiving more of a part than the ticket ordered.",
      "Held invoices appear in the table below with their status, and in the Control Log on the right, with the reason spelled out.",
      "Fix whatever it names — usually the vendor spelling or a typo in the total — and post it again.",
      "Over $500 you'll see a note suggesting you double-check the invoice. That's a nudge, not a hold; it posts either way.",
    ],
    related: ["post-vendor-invoice", "manage-vendors"],
  },

  {
    id: "manage-vendors",
    title: "Adding and naming vendors",
    view: "accounting",
    aliases: ["vendor", "supplier", "add a vendor", "parts store", "account number", "aliases", "spelled differently"],
    summary: "Vendors are set up once on the Accounts Payable screen, with aliases for the other ways their name gets written.",
    steps: [
      "On Accounts Payable, use the Vendors card on the right.",
      "Enter the vendor's name and, optionally, their account number.",
      "Put other spellings in Aliases — 'World Pac, WPAC' — so invoices match no matter how the name was typed.",
      "Save. The vendor now appears in the invoice form's dropdown.",
    ],
    related: ["post-vendor-invoice", "invoice-approval"],
  },

  {
    id: "cores-explained",
    title: "What the Cores screen is for",
    view: "cores",
    aliases: ["core", "cores", "core charge", "core deposit", "old part", "alternator", "caliper", "money back from the vendor", "core money"],
    summary: "Tracks core deposits the vendor owes back, so the shop actually collects them instead of eating the charge.",
    steps: [
      "A core charge is money the vendor adds to a part until you send the old one back.",
      "Cores & Returns lists every one still outstanding, with the charge and which RO and vehicle it came from.",
      "Each core moves through three states: Pending, Awaiting Credit, then Credited.",
      "The chips at the top filter to whichever state you care about.",
    ],
    related: ["core-workflow", "returned-parts"],
  },

  {
    id: "core-workflow",
    title: "Getting a core credited",
    view: "cores",
    aliases: ["driver picked it up", "sent it back", "core credit", "mark picked up", "vendor took it", "credit came in", "collect the core"],
    summary: "The three states walk a core from sitting on your shelf to credited on the vendor's account.",
    steps: [
      "Pending — the old part is still here. This is where cores start.",
      "When the vendor's driver collects it, select those rows and click 'Mark Picked Up'. They move to Awaiting Credit.",
      "Awaiting Credit — it's gone back but no paperwork has arrived.",
      "When the vendor's credit shows up, record it against the core. It becomes Credited and stops being money owed to you.",
    ],
    related: ["cores-explained", "returned-parts"],
  },

  {
    id: "returned-parts",
    title: "Sending a part back",
    view: "cores",
    aliases: ["return", "returns", "wrong part", "send it back", "didn't need it", "credit due", "returned parts", "restock"],
    summary: "Returned Parts is the lower half of the Cores screen — parts going back for credit rather than core deposits.",
    steps: [
      "Find the part in the Returned Parts section.",
      "Mark it picked up when the driver collects it.",
      "Record the credit once the vendor's paperwork arrives.",
      "It uses the same Pending / Awaiting Credit / Credited states as cores, so the two read the same way.",
    ],
    related: ["cores-explained", "core-workflow", "post-vendor-invoice"],
  },

  /* ── Team ─────────────────────────────────────────────────────── */

  {
    id: "add-staff",
    title: "Adding someone to the shop",
    view: "staff",
    aliases: ["staff", "employee", "new hire", "add a tech", "add a writer", "quit", "left", "remove someone", "deactivate"],
    summary: "Staff are technicians, advisors and managers — the people who can be assigned work.",
    steps: [
      "Open Staff and use the Add Staff card.",
      "Enter their name and pick a role: Technician, Advisor / Service Writer, or Manager.",
      "Managers can also be assigned as advisors on repair orders.",
      "When someone leaves, deactivate them rather than deleting — their name stays attached to the work they did.",
    ],
    related: ["assign-tech-and-advisor", "productivity-report", "working-as"],
  },

  {
    id: "tasks-basics",
    title: "Leaving a task for someone",
    view: "tasks",
    aliases: ["task", "to do", "todo", "reminder", "note for someone", "follow up", "call the customer back", "assign a job"],
    summary: "Shared to-dos for the shop — everyone sees the same list, and it updates the moment they open RECON.",
    steps: [
      "Open Tasks and type what needs doing in the box at the top.",
      "Pick who it's for, optionally link it to a vehicle and set a due date.",
      "Tick Urgent if it can't wait, then click Add Task.",
      "The cards across the top filter to Overdue, Due Today, or Unassigned in one click.",
      "Tick a task off when it's done; completed ones tuck away at the bottom.",
    ],
    related: ["tasks-from-the-board", "add-staff"],
  },

  {
    id: "tasks-from-the-board",
    title: "Making tasks from stalled vehicles",
    view: "vehicles",
    aliases: ["make tasks", "bulk task", "stalled cars", "chase these", "several at once", "follow up on all of them"],
    summary: "Turns a selection of vehicles into one task each, already linked to their tickets.",
    steps: [
      "On the Vehicles board, click the Stalled card to filter to cars nothing has happened to.",
      "Select the rows you can't deal with right now — Space, or Shift+click for a range.",
      "Click 'Make Tasks'. Each vehicle gets its own task, linked to its ticket.",
      "They arrive unassigned and undated — go to Tasks, select them all, and set an owner and a due date in one go.",
    ],
    related: ["tasks-basics", "idle-and-age", "vehicles-board"],
  },

  {
    id: "productivity-report",
    title: "Seeing what each technician produced",
    view: "reports",
    aliases: ["productivity", "tech report", "hours", "who did what", "labor", "performance", "technician report"],
    summary: "Repair orders, hours, and what each technician still has open, over any date range.",
    steps: [
      "Open Reports and pick the Technicians tab, or click 'Productivity Report' from the Staff screen.",
      "Choose a date range across the top.",
      "Download it as a spreadsheet or print it on letterhead.",
    ],
    related: ["run-a-report", "add-staff", "export-and-print-reports"],
  },

  {
    id: "post-an-idea",
    title: "Suggesting a change to RECON",
    view: "suggestions",
    aliases: ["idea", "ideas", "suggestion", "feature request", "this should", "wish list", "complaint", "annoying"],
    summary: "A running list of things that should be added or fixed in the system itself.",
    steps: [
      "Open Ideas from the left rail.",
      "Type what should be added or fixed and click Post Idea.",
      "Mark it done once it's been handled.",
    ],
    related: ["getting-started"],
  },

  /* ── Reports and data ─────────────────────────────────────────── */

  {
    id: "run-a-report",
    title: "Running a report",
    view: "reports",
    aliases: ["report", "reports", "how much did we spend", "totals", "month", "year", "numbers", "what did we do"],
    summary: "What the shop spent, what it produced and who did the work, over any stretch of time.",
    steps: [
      "Open Reports and pick which one: All Vehicles, Recon, We-Owe, or Technicians.",
      "Pick a range — Today, This Week, This Month, This Year, All Time, or type your own From and To dates.",
      "The cards and chart above the table describe exactly the rows below them.",
    ],
    related: ["export-and-print-reports", "productivity-report", "over-quote"],
  },

  {
    id: "export-and-print-reports",
    title: "Exporting or printing a report",
    view: "reports",
    aliases: ["csv", "excel", "spreadsheet", "export", "download", "print a report", "send to the accountant", "email the numbers"],
    summary: "Any report can leave as a spreadsheet or as paper.",
    steps: [
      "Set up the report and date range you want first — both buttons act on what's currently on screen.",
      "'Download CSV' saves a spreadsheet you can open in Excel.",
      "'Print' formats it on letterhead for the printer or a PDF.",
    ],
    related: ["run-a-report", "productivity-report"],
  },

  {
    id: "backup-basics",
    title: "How backups work",
    view: "backup",
    aliases: ["backup", "back up", "safe", "am i protected", "lost data", "copy", "automatic backup"],
    summary: "The whole database is backed up automatically every few minutes whenever something has changed, and older backups thin out over time instead of being dropped.",
    steps: [
      "Open Backup & Restore to see whether anything is waiting to be backed up and how many backups are on hand.",
      "Click 'Create Backup Now' any time you want one immediately — before something risky, for instance.",
      "Every backup in the list can be downloaded, restored, or deleted.",
      "Nothing is backed up when nothing has changed, so a quiet night doesn't fill the folder with identical copies.",
      "Recent backups are kept close together, then hourly, then daily, then monthly — so you can undo the last ten minutes or go back to last month.",
      "Backups only run on the main computer, so that one needs to be on for it to happen.",
    ],
    related: ["restore-a-backup", "backup-to-usb"],
  },

  {
    id: "update-recon",
    title: "Updating RECON",
    view: "backup",
    aliases: ["update", "upgrade", "new version", "version", "out of date", "install update", "newer", "latest"],
    summary: "The main computer hands out updates to every other PC — you update it once, and the rest follow.",
    steps: [
      "When a newer version is available, a bar appears across the top of RECON offering it. Nothing installs until you click Update Now, so it can never interrupt a ticket you're in the middle of.",
      "To put a new version on the main computer: right-click the RECON tray icon, choose 'Install Update From File...', and copy the RECON-Setup file into the folder that opens.",
      "That's all the main computer needs. Every other PC in the shop will see the update on its own and offer it.",
      "On the other PCs, click Update Now and follow the installer. Windows will ask for permission — that's normal, RECON installs for the whole machine.",
      "Your records, backups and settings are untouched by an update; they live outside the program folder on purpose.",
      "If a PC shows the notice but no Update Now button, you're looking at RECON in a web browser. Open the RECON app on that computer instead.",
    ],
    related: ["backup-basics", "backup-to-usb"],
  },

  {
    id: "backup-to-usb",
    title: "Taking a backup off-site",
    view: "backup",
    aliases: ["usb", "flash drive", "thumb drive", "take it home", "off site", "fire", "stolen", "external copy", "memory stick"],
    summary: "Backups sitting on the same computer don't survive that computer — a copy needs to physically leave.",
    steps: [
      "Download any backup from the list and save it to a USB stick.",
      "On the main computer, the RECON tray icon also has 'Backup To USB or Folder...', which copies straight to the stick.",
      "Once a stick has been chosen there, every later backup copies to it automatically whenever it's plugged in.",
      "A copy that never leaves the building isn't protecting you from much.",
    ],
    related: ["backup-basics", "restore-a-backup"],
  },

  {
    id: "restore-a-backup",
    title: "Restoring from a backup",
    view: "backup",
    aliases: ["restore", "undo", "go back", "recover", "lost work", "messed up", "yesterday's data", "put it back"],
    summary: "Replaces the entire database with an earlier copy — everything, not one record.",
    steps: [
      "Open Backup & Restore.",
      "Restore one from the list, or drop a .db file into 'Restore From a File' if it came from a USB stick.",
      "The current database is saved aside first, so a restore can itself be undone.",
      "This is all-or-nothing: everything entered since that backup goes away. To fix one mistake, fix the record instead.",
    ],
    related: ["backup-basics", "backup-to-usb", "void-vs-delete"],
  },

];

/* How the Help screen is grouped. Deliberately by task rather than by rail
   screen: 28 of these topics live on Vehicles, because that's where the app
   lives, and one enormous section next to eight thin ones is worse to read
   than the order someone actually meets these things in. The topic's `view`
   is still what "Take me there" uses -- this only controls headings.

   Every topic belongs to exactly one group; test_help_content.py checks that,
   so a new topic can't be added and then quietly never shown. */
const HELP_GROUPS = [
  {
    title: "Getting oriented",
    ids: ["getting-started", "recon-vs-we-owe", "working-as", "keyboard-shortcuts"],
  },
  {
    title: "The Vehicles board",
    ids: ["vehicles-board", "find-a-vehicle", "idle-and-age", "over-quote"],
  },
  {
    title: "Starting work on a vehicle",
    ids: [
      "add-recon-vehicle", "add-we-owe", "start-repair-order", "add-parts-and-labor",
      "order-parts", "receive-parts", "assign-tech-and-advisor", "vehicle-status",
    ],
  },
  {
    title: "While the car is here",
    ids: [
      "vehicle-notes", "vehicle-activity", "promised-time", "vehicle-totals",
      "print-ticket", "take-a-deposit", "we-owe-close-out",
    ],
  },
  {
    title: "Finishing and undoing",
    ids: ["send-to-history", "void-vs-delete"],
  },
  {
    title: "Customers",
    ids: ["find-a-customer", "edit-customer-info", "add-customer-vehicle"],
  },
  {
    title: "Vendors, invoices and cores",
    ids: [
      "post-vendor-invoice", "invoice-approval", "manage-vendors",
      "cores-explained", "core-workflow", "returned-parts",
    ],
  },
  {
    title: "Staff and tasks",
    ids: ["add-staff", "tasks-basics", "tasks-from-the-board", "productivity-report", "post-an-idea"],
  },
  {
    title: "Reports, backups and your data",
    ids: ["run-a-report", "export-and-print-reports", "backup-basics", "backup-to-usb", "restore-a-backup", "update-recon"],
  },
];
