// The test environment's books: the library on disk, and the fake Audible and
// Libro.fm stores behind Get books. Everything here is invented for testing.

// [title, author, narrator, genre, series, series position, cover colour]
export const library = [
  ["A Memory Called Empire", "Arkady Martine", "Mary Robinette Kowal", "Science fiction", "Teixcalaan", "1", "#6b2a2a"],
  ["A Desolation Called Peace", "Arkady Martine", "Mary Robinette Kowal", "Science fiction", "Teixcalaan", "2", "#4a2f5c"],
  ["Ancillary Justice", "Ann Leckie", "Adjoa Andoh", "Science fiction", "Imperial Radch", "1", "#2f5d62"],
  ["Ancillary Sword", "Ann Leckie", "Adjoa Andoh", "Science fiction", "Imperial Radch", "2", "#3d4e6b"],
  ["Ancillary Mercy", "Ann Leckie", "Adjoa Andoh", "Science fiction", "Imperial Radch", "3", "#5a3b2e"],
  ["Anna Karenina", "Leo Tolstoy", "Maggie Gyllenhaal", "Classics", "", "", "#c9c2b4"],
  ["Babel", "R. F. Kuang", "Chris Lew Kum Hoi", "Fantasy", "", "", "#7a5a1f"],
  ["Beloved", "Toni Morrison", "Toni Morrison", "Literary fiction", "", "", "#d6a85a"],
  ["Bleak House", "Charles Dickens", "Sean Barrett", "Classics", "", "", "#3a3734"],
  ["Circe", "Madeline Miller", "Perdita Weeks", "Fantasy", "", "", "#8a6d2f"],
  ["Cloud Atlas", "David Mitchell", "Scott Brick", "Literary fiction", "", "", "#44505c"],
  ["Dune", "Frank Herbert", "Scott Brick", "Science fiction", "Dune", "1", "#6a4a1c"],
  ["Dune Messiah", "Frank Herbert", "Scott Brick", "Science fiction", "Dune", "2", "#80562a"],
  ["Children of Dune", "Frank Herbert", "Scott Brick", "Science fiction", "Dune", "3", "#5c3d1a"],
  ["God Emperor of Dune", "Frank Herbert", "Simon Vance", "Science fiction", "Dune", "4", "#4b3316"],
  ["Heretics of Dune", "Frank Herbert", "Simon Vance", "Science fiction", "Dune", "5", "#3d2a12"],
  ["Chapterhouse Dune", "Frank Herbert", "Simon Vance", "Science fiction", "Dune", "6", "#2e1f0d"],
  ["Educated", "Tara Westover", "Julia Whelan", "Memoir", "", "", "#2f6f73"],
  ["Gideon the Ninth", "Tamsyn Muir", "Moira Quirk", "Fantasy", "The Locked Tomb", "1", "#1f1f22"],
  ["Harrow the Ninth", "Tamsyn Muir", "Moira Quirk", "Fantasy", "The Locked Tomb", "2", "#5b1f1f"],
  ["Nona the Ninth", "Tamsyn Muir", "Moira Quirk", "Fantasy", "The Locked Tomb", "3", "#7a2e3e"],
  ["Hyperion", "Dan Simmons", "Victor Bevine", "Science fiction", "", "", "#2e4a7a"],
  ["Jade City", "Fonda Lee", "Andrew Kishino", "Fantasy", "", "", "#2f5a3a"],
  ["Klara and the Sun", "Kazuo Ishiguro", "Sura Siu", "Literary fiction", "", "", "#c98f3c"],
  ["Leviathan Wakes", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "1", "#20384f"],
  ["Caliban's War", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "2", "#28445c"],
  ["Abaddon's Gate", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "3", "#30506a"],
  ["Cibola Burn", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "4", "#385c77"],
  ["Nemesis Games", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "5", "#406885"],
  ["Babylon's Ashes", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "6", "#487492"],
  ["Persepolis Rising", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "7", "#5080a0"],
  ["Tiamat's Wrath", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "8", "#588cad"],
  ["Leviathan Falls", "James S. A. Corey", "Jefferson Mays", "Science fiction", "The Expanse", "9", "#6098ba"],
  ["Middlemarch", "George Eliot", "Juliet Stevenson", "Classics", "", "", "#5a4a2a"],
  ["Moby-Dick", "Herman Melville", "William Hootkins", "Classics", "", "", "#3b3b3e"],
  ["Neuromancer", "William Gibson", "Robertson Dean", "Science fiction", "", "", "#2a2a3e"],
  ["Piranesi", "Susanna Clarke", "Chiwetel Ejiofor", "Fantasy", "", "", "#3f6b6e"],
  ["Project Hail Mary", "Andy Weir", "Ray Porter", "Science fiction", "", "", "#9a4f2a"],
  ["Rebecca", "Daphne du Maurier", "Anna Massey", "Classics", "", "", "#4a1f2a"],
  ["Station Eleven", "Emily St. John Mandel", "Kirsten Potter", "Literary fiction", "", "", "#6e5a3a"],
  ["The Brothers Karamazov", "Fyodor Dostoevsky", "Constantine Gregory", "Classics", "", "", "#7a5420"],
  ["The Fifth Season", "N. K. Jemisin", "Robin Miles", "Fantasy", "The Broken Earth", "1", "#5c2f1f"],
  ["The Obelisk Gate", "N. K. Jemisin", "Robin Miles", "Fantasy", "The Broken Earth", "2", "#6e3a24"],
  ["The Stone Sky", "N. K. Jemisin", "Robin Miles", "Fantasy", "The Broken Earth", "3", "#80452a"],
  ["The Name of the Wind", "Patrick Rothfuss", "Nick Podehl", "Fantasy", "", "", "#4f2a1a"],
  ["Uprooted", "Naomi Novik", "Julia Emelin", "Fantasy", "", "", "#2f4a2a"],
  ["Wolf Hall", "Hilary Mantel", "Simon Slater", "Historical fiction", "", "", "#3a2a1a"],
  ["Ender's Game", "Orson Scott Card", "Stefan Rudnicki", "Science fiction", "", "", "#24304a"],
  ["Frankenstein", "Mary Shelley", "Dan Stevens", "Classics", "", "", "#2a3a2a"],
  ["Gone Girl", "Gillian Flynn", "Julia Whelan", "Thriller", "", "", "#1f2a3a"],
];

// Audible books, as the fake Libation CLI exports them.
export const AUDIBLE_US = "rowan.reads@example.test";
export const AUDIBLE_UK = "household.uk@example.test";
// [account, title, subtitle, authors, narrators, minutes, publisher, liberated, cover colour, Audible Plus]
export const audible = [
  [AUDIBLE_US, "Circe", "", "Madeline Miller", "Perdita Weeks", 724, "Hachette Audio", true, "#8a6d2f"],
  [AUDIBLE_US, "Project Hail Mary", "", "Andy Weir", "Ray Porter", 970, "Audible Studios", true, "#a24d2a"],
  [AUDIBLE_US, "Gideon the Ninth", "The Locked Tomb, Book 1", "Tamsyn Muir", "Moira Quirk", 924, "Recorded Books", true, "#2b2b2b"],
  [AUDIBLE_US, "The Wise Man's Fear", "The Kingkiller Chronicle, Day Two", "Patrick Rothfuss", "Nick Podehl", 2611, "Brilliance Audio", false, "#4b3a26"],
  [AUDIBLE_US, "The Left Hand of Darkness", "", "Ursula K. Le Guin", "George Guidall", 691, "Recorded Books", false, "#3c5a74"],
  [AUDIBLE_US, "The Way of Kings", "The Stormlight Archive, Book 1", "Brandon Sanderson", "Michael Kramer, Kate Reading", 2729, "Macmillan Audio", false, "#365a7a"],
  [AUDIBLE_US, "Red Rising", "", "Pierce Brown", "Tim Gerard Reynolds", 980, "Recorded Books", false, "#7c1f1f"],
  [AUDIBLE_US, "The Martian", "", "Andy Weir", "R. C. Bray", 653, "Podium Audio", false, "#b5562b"],
  [AUDIBLE_US, "Sea of Tranquility", "", "Emily St. John Mandel", "John Lee", 351, "Random House Audio", false, "#2f5470"],
  [AUDIBLE_US, "Tomorrow, and Tomorrow, and Tomorrow", "", "Gabrielle Zevin", "Jennifer Kim, Julian Cihi", 1189, "Random House Audio", false, "#c0713a"],
  [AUDIBLE_US, "A Psalm for the Wild-Built", "Monk & Robot, Book 1", "Becky Chambers", "Emmett Grosland", 254, "Macmillan Audio", false, "#4d7a4a"],
  [AUDIBLE_US, "All Systems Red", "The Murderbot Diaries, Book 1", "Martha Wells", "Kevin R. Free", 195, "Recorded Books", false, "#5b5f6b", true],
  [AUDIBLE_US, "Legends & Lattes", "", "Travis Baldree", "Travis Baldree", 469, "Podium Audio", false, "#7a4b2a", true],
  [AUDIBLE_US, "The House in the Cerulean Sea", "", "TJ Klune", "Daniel Henning", 735, "Macmillan Audio", false, "#3f8a8c"],
  [AUDIBLE_UK, "Jonathan Strange & Mr Norrell", "", "Susanna Clarke", "Simon Prebble", 1928, "Bloomsbury", false, "#2b3a2f"],
  [AUDIBLE_UK, "The Secret History", "", "Donna Tartt", "Donna Tartt", 1323, "Penguin Audio", false, "#5a2a3a"],
  [AUDIBLE_UK, "Never Let Me Go", "", "Kazuo Ishiguro", "Rosalyn Landor", 609, "Faber & Faber", false, "#6c7f8a"],
  [AUDIBLE_UK, "The Remains of the Day", "", "Kazuo Ishiguro", "Simon Prebble", 455, "Faber & Faber", false, "#8a7a5a"],
  [AUDIBLE_UK, "The Thursday Murder Club", "", "Richard Osman", "Lesley Manville", 690, "Penguin Audio", false, "#a8452f"],
  [AUDIBLE_UK, "Children of Time", "", "Adrian Tchaikovsky", "Mel Hudson", 976, "Macmillan Audio UK", false, "#2d5a3f"],
  [AUDIBLE_UK, "Wolf Hall", "", "Hilary Mantel", "Simon Slater", 1484, "Macmillan Audio UK", true, "#5b3a6a"],
  [AUDIBLE_UK, "Piranesi", "", "Susanna Clarke", "Chiwetel Ejiofor", 384, "Bloomsbury", false, "#2f6a74"],
];

// Libro.fm accounts and their books, as Libro.fm's API describes them.
export const LIBRO_READER = "rowan@libro.test";
export const LIBRO_SHARED = "bookclub@libro.test";
export const libroAccounts = [[LIBRO_READER, "Rowan"], [LIBRO_SHARED, "Book club"]];
// [account, isbn, title, authors, narrators, seconds, publisher, published, series, series position, genre]
export const libro = [
  [LIBRO_READER, "9781250313188", "The Fifth Season", ["N. K. Jemisin"], ["Robin Miles"], 54000, "Hachette Audio", "2015-08-04", "The Broken Earth", "1", "Fantasy"],
  [LIBRO_READER, "9781549151767", "The Priory of the Orange Tree", ["Samantha Shannon"], ["Liyah Summers"], 88200, "Bloomsbury", "2019-02-26", "", "", "Fantasy"],
  [LIBRO_READER, "9780593168264", "Klara and the Sun", ["Kazuo Ishiguro"], ["Sura Siu"], 36900, "Random House Audio", "2021-03-02", "", "", "Literary fiction"],
  [LIBRO_READER, "9781250851710", "Nettle & Bone", ["T. Kingfisher"], ["Mary Robinette Kowal"], 35400, "Macmillan Audio", "2022-04-26", "", "", "Fantasy"],
  [LIBRO_READER, "9780593460351", "Some Desperate Glory", ["Emily Tesh"], ["Jessica Almasy"], 54600, "Macmillan Audio", "2023-04-11", "", "", "Science fiction"],
  [LIBRO_READER, "9781250847041", "Translation State", ["Ann Leckie"], ["Adjoa Andoh"], 52200, "Hachette Audio", "2023-06-06", "Imperial Radch", "4", "Science fiction"],
  [LIBRO_READER, "9780593502051", "Lessons in Chemistry", ["Bonnie Garmus"], ["Miranda Raison"], 42900, "Random House Audio", "2022-04-05", "", "", "Historical fiction"],
  [LIBRO_READER, "9781250229861", "Network Effect", ["Martha Wells"], ["Kevin R. Free"], 41400, "Recorded Books", "2020-05-05", "The Murderbot Diaries", "5", "Science fiction"],
  [LIBRO_SHARED, "9780063021433", "Demon Copperhead", ["Barbara Kingsolver"], ["Charlie Thurston"], 76500, "HarperAudio", "2022-10-18", "", "", "Literary fiction"],
  [LIBRO_SHARED, "9780593556795", "The Covenant of Water", ["Abraham Verghese"], ["Abraham Verghese"], 112800, "Grove Press", "2023-05-02", "", "", "Literary fiction"],
  [LIBRO_SHARED, "9781984888211", "Hamnet", ["Maggie O'Farrell"], ["Ell Potter"], 36000, "Random House Audio", "2020-07-21", "", "", "Historical fiction"],
  [LIBRO_SHARED, "9780593209925", "The Midnight Library", ["Matt Haig"], ["Carey Mulligan"], 31200, "Penguin Audio", "2020-09-29", "", "", "Literary fiction"],
];
