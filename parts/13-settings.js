    // ==================== 12. 设置面板入口 ====================

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('eo_menu_item')) return;
        const item = document.createElement('div');
        item.id = 'eo_menu_item';
        item.className = 'extension_container interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" tabindex="0">'
            + '<div class="fa-solid fa-list-check extensionsMenuExtensionButton"></div>'
            + '<span>事件大纲</span></div>';
        item.addEventListener('click', () => togglePanel(true));
        menu.appendChild(item);
    }

