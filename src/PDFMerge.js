import { PDFDocument } from 'pdf-lib';
import { html, render } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { classMap } from 'lit-html/directives/class-map.js';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

class PDFManager {

	static events = {
		mergeStatus: 'pdfMergeStatus'
	};

	static parsePageRange(pageRange, maxPageCount) {

		const trimmed = String(pageRange).replace(/\s+/g, '');
		if (trimmed === '') return { pages: [...Array(maxPageCount).keys()], hasError: false };

		const parts = trimmed.split(',').filter(part => part !== '');
		if (parts.length === 0) return { pages: [], hasError: true };

		const pages = new Set();
		let hasError = false;

		parts.forEach(part => {
			if (/^\d+-\d+$/.test(part)) {
				const [start, end] = part.split('-').map(Number);
				if (start >= 1 && end >= start && end <= maxPageCount) {
					for (let i = start; i <= end; i++) pages.add(i - 1);
				} else hasError = true;
			} else if (/^\d+$/.test(part)) {
				const page = Number(part);
				if (page >= 1 && page <= maxPageCount) pages.add(page - 1);
				else hasError = true;
			} else hasError = true;
		});

		return {
			pages: hasError ? [] : [...pages].sort((a, b) => a - b),
			hasError
		};
	}

	static async loadPDF(pdfBuffer, fileInfo) {
		
		const formatBytes = (byte) => {
			if (!isFinite(byte) || byte <= 0) return '0 B';
			const units = ['B', 'KiB', 'MiB', 'GiB'];
			const base = 1024;
			const unitsIndex = Math.min(units.length - 1,
				Math.max(0,
					Math.floor(Math.log(byte) / Math.log(base))
				)
			);
			return `${Number((byte / base ** unitsIndex).toFixed(2))} ${units[unitsIndex]}`;
		}

		const {fileName, fileSize} = fileInfo;

		const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
		
		return {
			pdfDoc,
			uuid: crypto.randomUUID(),
			selectedPages: '',
			meta: {
				fileName: fileName ?? 'Untitled.pdf',
				fileSize: formatBytes(fileSize),
				pageCount: pdfDoc.getPageCount(),
				title: pdfDoc.getTitle() ?? '',
				author: pdfDoc.getAuthor() ?? '',
				subject: pdfDoc.getSubject() ?? '',
				keywords: pdfDoc.getKeywords() ?? '',
				producer: pdfDoc.getProducer() ?? '',
				creator: pdfDoc.getCreator() ?? '',
				creationDate: pdfDoc.getCreationDate() ?? null,
				modificationDate: pdfDoc.getModificationDate() ?? null
			}
		};
	}

	static async mergePDF(pdfList, globalMeta) {

		PDFManager.#dispatchStatus('start');
		
		try {
			const mergedDoc = await PDFDocument.create();

			for (const item of pdfList) {
				const maxPage = item.meta.pageCount;
				const { pages, hasError } = PDFManager.parsePageRange(item.selectedPages, maxPage);
				
				if (hasError) {
					throw new Error(`${item.meta.fileName} has an invalid page range selection.`, { cause: { type: 'range', source: item.meta.fileName } });
				}
				
				const copiedPages = await mergedDoc.copyPages(item.pdfDoc, pages);
				copiedPages.forEach(page => mergedDoc.addPage(page));
			}

			PDFManager.#applyMetadata(mergedDoc, globalMeta);

			const bytes = await mergedDoc.save({ updateMetadata: false });
			PDFManager.#dispatchStatus('success');
			return bytes;

		} catch (err) {
			PDFManager.#dispatchStatus('error');
			throw new Error(err.message, { cause: { origErr: err, origCause: err.cause, type: 'mergeError' } });
		}
	}

	static #applyMetadata(doc, meta) {
		const setterMap = {
			title: (v) => doc.setTitle(String(v)),
			author: (v) => doc.setAuthor(String(v)),
			subject: (v) => doc.setSubject(String(v)),
			keywords: (v) => doc.setKeywords(v.split(/[\s,]+/).filter(k => k)),
			producer: (v) => doc.setProducer(String(v)),
			creator: (v) => doc.setCreator(String(v)),
			creationDate: (v) => v instanceof Date && doc.setCreationDate(v),
			modificationDate: (v) => v instanceof Date && doc.setModificationDate(v),
		};

		Object.entries(meta).forEach(([key, value]) => {
			if ((value !== undefined && value !== null) && setterMap[key]) setterMap[key](value);
		});
	}

	static #dispatchStatus(status) {
		window.dispatchEvent(new CustomEvent(PDFManager.events.mergeStatus, {
			detail: { status }
		}));
	}
}

class App {
	#cleanupListEvents = [];
	#elements = {};
	#files = [];

	#selectors = {
		pdfDropContainer: '.pdf-drop-container',
		fileItemList: '.file-item-list',
		dropPlaceholder: '.drop-placeholder',
		fileSelector: '#fileSelector',
		metaEditorForm: '#metaEditorForm',
		metaClearBtn: '#metaClearBtn',
		mergeBtn: '#mergeBtn',
		pageCountDisplay: '#pageCountDisplay span',
		loadingOverlay: '#loadingOverlay',
		completeOverlay: '#completeOverlay',
		errorDialog: '#errorDialog',
		dialogTitle: '#dialogTitle > span',
		dialogDescription: '#dialogDescription',
		dialogErrorLog: '#dialogErrorLog'
	};

	#uiTokens = {
		hidden: '.hidden',
		invalidRange: '.invalid-range',
		fileTrashBtn: '.file-trash-btn',
		listHandle: '.list-handle',
		pageSelect: 'pageSelect',
		infoEnable: 'infoEnable',
		datetimeField: '.datetime-field',
		datetimePickerGroup: '.datetime-picker-group',
		pdfItemCard: '.pdf-item-card',
		dialogCloseBtn: '.dialog-close-btn',
		getRawName(property) {
			if (!Object.hasOwn(this, property)) throw new Error(`Property ${property} is not defined.`);
			return this[property].replace(/^[#.]/, '');
		}
	}

	#dateFormatOption = {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}

	constructor() {
		this.#cacheElements();
		this.#bindEvents();
	}

	#cacheElements() {
		Object.entries(this.#selectors).forEach(([key, selector]) => {
			this.#elements[key] = document.querySelector(selector);
		});
	}

	#bindEvents() {

		this.#elements.pdfDropContainer?.addEventListener('dragover', this.#handleDragOver.bind(this));
		this.#elements.pdfDropContainer?.addEventListener('dragleave', this.#handleDragLeave.bind(this));
		this.#elements.pdfDropContainer?.addEventListener('drop', this.#handleDrop.bind(this));
		this.#elements.pdfDropContainer?.addEventListener('click', this.#handleClick.bind(this));

		this.#elements.fileSelector?.addEventListener('change', this.#handleInputFileChange.bind(this));

		this.#elements.fileItemList?.addEventListener('click', this.#handleListClick.bind(this));
		this.#elements.fileItemList?.addEventListener('input', this.#handleListInput.bind(this));

		this.#elements.metaClearBtn?.addEventListener('click', this.#clearMeta.bind(this));
		this.#elements.metaEditorForm?.addEventListener('change', this.#handleMetaChange.bind(this));

		this.#elements.mergeBtn?.addEventListener('click', this.#executeMerge.bind(this));

		this.#elements.errorDialog?.addEventListener('click', this.#toggleDialog.bind(this));

		window.addEventListener(PDFManager.events.mergeStatus, this.#toggleOverlay.bind(this));
	}

	#createFilesProxy(fileObj) {
		return new Proxy(fileObj, {
			set: (target, prop, value) => {
				target[prop] = value;
				if (prop === 'selectedPages') this.#updateTotalPageCount();
				return true;
			}
		});
	}

	#handleDragOver(e) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.currentTarget.classList.add('dragover');
	}

	#handleDragLeave(e) {
		e.currentTarget.classList.remove('dragover');
	}

	#handleDrop(e) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.currentTarget.classList.remove('dragover');
		this.#readFiles(e.dataTransfer.files);
	}

	#handleClick(e) {
		if (e.target.closest(this.#uiTokens.pdfItemCard)) return;
		this.#elements.fileSelector?.click();
	}

	#handleInputFileChange(e) {
		this.#readFiles(e.target.files);
	}

	async #readFiles(fileList) {
		const files = Array.from(fileList);

		const results = await Promise.allSettled(
			files.map(async file => {
				const pdfData = await PDFManager.loadPDF(
					await file.arrayBuffer(),
					{ fileName: file.name, fileSize: file.size }
				);
				return this.#createFilesProxy(pdfData);
			})
		);

		const logCondition = [
			{ key: 'encrypted', log: (name) => `${name}はパスワードで保護されています。` },
			{ key: 'header', log: (name) => `${name}はPDFでは無いか，破損しています。` },
			{ key: 'Cannot', log: (name) => `${name}はPDFでは無いか，破損しています。` }
		];

		const errors = [];

		results.forEach((result, index) => {
			if (result.status === 'fulfilled') {
				this.#files.push(result.value);
			} else {
				const file = files[index];
				const errMsg = result.reason?.message ?? '';
				const matchedCond = logCondition.find(cond => errMsg.includes(cond.key));
				const log = matchedCond
					? matchedCond.log(file.name)
					: `${file.name}の読み込み中にエラーが発生しました。${errMsg ? `：${errMsg}` : ''}`;
				errors.push(log);
			}
		});

		if (errors.length > 0) {
			const errObj = {
				title: 'Error',
				description: 'ファイル読み込み中にエラーが発生しました。',
				log: errors.join('\n')
			};
			this.#setDialogVisible(true, errObj);
		}

		this.#renderPDFList();
	}

	#handleListClick(e) {
		const trashBtn = e.target.closest(this.#uiTokens.fileTrashBtn);
		if (trashBtn) {
			const uuid = trashBtn.closest(this.#uiTokens.pdfItemCard)?.dataset.pdfId;
			const targetIndex = this.#files.findIndex(f => f.uuid === uuid);
			if (targetIndex !== -1) {
				this.#files[targetIndex].pdfDoc = null;
				this.#files.splice(targetIndex, 1);
			}
			this.#renderPDFList();
		}
	}

	#handleListInput(e) {
		const pageInput = e.target.closest(`input[name="${this.#uiTokens.pageSelect}"]`);
		if (pageInput) {
			const uuid = pageInput.closest(this.#uiTokens.pdfItemCard)?.dataset.pdfId
			const file = this.#files.find(file => file.uuid === uuid);
			if (file) {
				file.selectedPages = pageInput.value;
				const { hasError } = PDFManager.parsePageRange(file.selectedPages, file.meta.pageCount);
				pageInput.closest(this.#uiTokens.pdfItemCard)?.classList.toggle(this.#uiTokens.getRawName('invalidRange'), hasError);
			}
		}

		const infoInput = e.target.closest(`input[name="${this.#uiTokens.infoEnable}"]`);
		if (infoInput && infoInput.checked) {
			this.#elements.fileItemList?.querySelectorAll(`input[name="${this.#uiTokens.infoEnable}"]`).forEach(el => {
				if (el !== infoInput) el.checked = false;
			});
		}
	}

	#clearMeta() {
		this.#elements.metaEditorForm?.querySelectorAll('input').forEach(input => {
			if (input.type === 'checkbox') input.checked = true;
			else input.value = '';
		});
		this.#elements.metaEditorForm?.querySelectorAll(`${this.#uiTokens.datetimeField} span`).forEach(s => s.textContent = '');
	}

	#handleMetaChange(e) {
		const dtInput = e.target.closest('input[type="datetime-local"]');
		if (dtInput) {
			const display = dtInput.closest(this.#uiTokens.datetimeField)?.querySelector('span');
			if (display) display.textContent = dtInput.value ? new Date(dtInput.value).toLocaleString('ja-JP', { ...this.#dateFormatOption, second : undefined }) : '';
		}
	}

	async #executeMerge() {
		if (this.#files.length <= 0) return;

		try {
			const meta = this.#getGlobalMetaData();
			const mergedBytes = await PDFManager.mergePDF(this.#files, meta);
			await this.#saveFile(mergedBytes, meta.title || 'merged.pdf');
		} catch (err) {
			
			const { origErr, origCause, type } = err.cause ?? {};
			const isMergeErr = type === 'mergeError';

			const errObj = {
				title: 'Error',
				description: isMergeErr ? '結合中にエラーが発生しました。' : '保存中にエラーが発生しました。',
				log: isMergeErr && origCause?.type === 'range'
					? `${origCause.source ? `${origCause.source}で` : ''}無効なページ範囲が選択されています。`
					: origErr?.message || err.message
			};

			this.#setDialogVisible(true, errObj);
		}
	}

	#getGlobalMetaData() {
		const meta = {};

		this.#elements.metaEditorForm?.querySelectorAll('input[type="text"]').forEach(input => {
			if (input.name) meta[input.name] = input.value;
		});

		const now = new Date();
		this.#elements.metaEditorForm?.querySelectorAll(this.#uiTokens.datetimePickerGroup).forEach(container => {
			const dateInput = container.querySelector('input[type="datetime-local"]');
			if (!dateInput || !dateInput.name) return;
			const useNow = container.querySelector('input[type="checkbox"]')?.checked ?? true;
			meta[dateInput.name] = useNow ? now : (dateInput.value ? new Date(dateInput.value) : null);
		});
		return meta;
	}

	#toggleDialog(e) {
		if (e.target.closest(this.#uiTokens.dialogCloseBtn)) this.#setDialogVisible(false);
	}

	#toggleOverlay(e) {
		const status = e.detail?.status;
		const loading = this.#elements.loadingOverlay;
		const complete = this.#elements.completeOverlay;
		loading?.classList.toggle(this.#uiTokens.getRawName('hidden'), status !== 'start');
		if (status === 'success') {
			complete?.classList.remove(this.#uiTokens.getRawName('hidden'));
			setTimeout(() => complete.classList.add(this.#uiTokens.getRawName('hidden')), 1000);
		}
	}

	#renderPDFList() {
		if (!this.#elements.fileItemList) return;

		const isHidden = this.#files.length > 0;
		this.#elements.dropPlaceholder?.classList.toggle(this.#uiTokens.getRawName('hidden'), isHidden);

		const template = html`
			${repeat(
				this.#files,
				file => file.uuid,
				file => this.#createFileTemplate(file)
			)}
		`;

		render(template, this.#elements.fileItemList);
		this.#setupDragAndDrop();
		this.#updateTotalPageCount();
	}

	#createFileTemplate(file) {
		const { meta, uuid, selectedPages } = file;
		const { hasError } = PDFManager.parsePageRange(selectedPages, meta.pageCount);

		const infoItems = Object.entries(meta).map(([key, value]) => html`
			<p>${key}</p>：<p>${this.#formatMetaValue(value)}</p>
		`);

		const cardClasses = classMap({
			[this.#uiTokens.getRawName('pdfItemCard')]: true,
			[this.#uiTokens.getRawName('invalidRange')]: hasError
		});

		return html`
			<div class="${cardClasses}" data-pdf-id="${uuid}">
				<i class="fa-solid fa-bars ${this.#uiTokens.getRawName('listHandle')}"></i>
				<p>${meta.fileName}</p>
				<input type="text" name="${this.#uiTokens.pageSelect}" .value="${selectedPages}" placeholder="All">
				<i class="fa-solid fa-circle-info info-toggle-btn">
					<input type="checkbox" name="${this.#uiTokens.infoEnable}"></i>
				<i class="fa-solid fa-trash ${this.#uiTokens.getRawName('fileTrashBtn')}"></i>
				<div class="file-detail-tooltip">${infoItems}</div>
			</div>
		`;
	}

	#formatMetaValue(val) {
		if (val instanceof Date) return isNaN(val) ? '-' : val.toLocaleString('ja-JP', this.#dateFormatOption);
		return val || '-';
	}

	#setupDragAndDrop() {

		this.#cleanupListEvents.forEach(cleanup => cleanup());
		this.#cleanupListEvents = [];

		const cards = this.#elements.fileItemList?.querySelectorAll(this.#uiTokens.pdfItemCard);
		if (!cards || !this.#elements.pdfDropContainer) return;

		const cleanupAutoScroll = autoScrollForElements({
			element: this.#elements.pdfDropContainer,
			canScroll: () => true
		});
		this.#cleanupListEvents.push(cleanupAutoScroll);

		cards.forEach((cardEl) => {
			const uuid = cardEl.dataset.pdfId;
			const handleEl = cardEl.querySelector(this.#uiTokens.listHandle);
			if (!uuid || !handleEl) return;

			const cleanupDraggable = draggable({
				element: cardEl,
				dragHandle: handleEl,
				getInitialData: () => ({ uuid }),
				onDragStart: () => {
					cardEl.classList.add('is-dragging');
				},
				onDrop: () => {
					cardEl.classList.remove('is-dragging');
				}
			});

			const cleanupDropTarget = dropTargetForElements({
				element: cardEl,
				getData: ({ input, element }) => {
					return attachClosestEdge({ uuid }, {
						input,
						element,
						allowedEdges: ['top', 'bottom']
					});
				},
				onDragEnter: ({ self }) => {
					this.#updateDropEdge(cardEl, self);
				},
				onDrag: ({ self }) => {
					this.#updateDropEdge(cardEl, self);
				},
				onDragLeave: () => {
					this.#clearDropEdge(cardEl);
				},
				onDrop: ({ source, self }) => {
					this.#clearDropEdge(cardEl);

					const sourceUuid = source.data.uuid;
					const targetUuid = self.data.uuid;
					if (!sourceUuid || !targetUuid) return;

					const edge = extractClosestEdge(self.data);
					if (!edge) return;

					const startIndex = this.#files.findIndex(f => f.uuid === sourceUuid);
					let targetIndex = this.#files.findIndex(f => f.uuid === targetUuid);
					if (startIndex === -1 || targetIndex === -1) return;

					if (edge === 'bottom' && startIndex > targetIndex) targetIndex += 1;
					else if (edge === 'top' && startIndex < targetIndex) targetIndex -= 1;
					if (startIndex === targetIndex) return;

					this.#files = reorder({
						list: this.#files,
						startIndex,
						finishIndex: targetIndex
					});

					this.#renderPDFList();
				}
			});

			this.#cleanupListEvents.push(cleanupDraggable, cleanupDropTarget);
		});
	}

	#updateDropEdge(cardEl, selfData) {
		const edge = extractClosestEdge(selfData.data);
		cardEl.removeAttribute('data-drop-edge');
		if (edge) cardEl.setAttribute('data-drop-edge', edge);
	}

	#clearDropEdge(cardEl) {
		cardEl.removeAttribute('data-drop-edge');
	}

	#updateTotalPageCount() {
		const total = this.#files.reduce((sum, file) => {
			const { pages, hasError } = PDFManager.parsePageRange(file.selectedPages, file.meta.pageCount);
			return hasError ? sum : sum + pages.length;
		}, 0);
		if (this.#elements.pageCountDisplay) this.#elements.pageCountDisplay.textContent = this.#files.length ? total : '−';
	}

	#setDialogVisible(visible, content = {}) {
		const popup = this.#elements.errorDialog;
		if (!popup) return;
		if (!visible) {
			if (popup.open) popup.close();
			this.#resetDialogContent();
			return;
		}
		this.#updateDialogContent(content);
		if (!popup.open) popup.showModal();
	}

	#updateDialogContent({ title = '', description = '', log = '' } = {}) {
		const titleEl = this.#elements.dialogTitle;
		const descEl = this.#elements.dialogDescription;
		const errorlogEl = this.#elements.dialogErrorLog;

		if (titleEl) titleEl.textContent = title;
		if (descEl) descEl.textContent = description;
		if (errorlogEl && log) {
			errorlogEl.value += `${log}\n`;
		}
	}

	#resetDialogContent() {
		const titleEl = this.#elements.dialogTitle;
		const descEl = this.#elements.dialogDescription;
		const errorlogEl = this.#elements.dialogErrorLog;

		if (titleEl) titleEl.textContent = '';
		if (descEl) descEl.textContent = '';
		if (errorlogEl) errorlogEl.value = '';
	}

	async #saveFile(bytes, suggestedName) {
		if ('showSaveFilePicker' in window) {	
			try {
				const handle = await showSaveFilePicker({
					suggestedName,
					excludeAcceptAllOption: true,
					types: [{
						description: 'PDF Documents',
						accept: { 'application/pdf': ['.pdf'] }
					}]
				});
				const writable = await handle.createWritable();
				await writable.write(bytes);
				await writable.close();
				return;
			} catch(err) {
				if (err.name !== 'AbortError') throw err;
				return;
			}
		}
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = suggestedName;
		document.body.append(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}
}

new App();